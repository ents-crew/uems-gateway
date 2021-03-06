// Handles receiving a HTTP REST request and processing that into a message
// to be sent onto a microservice.

import { Channel, Message } from 'amqplib/callback_api';
import { Connection as Connection_ } from 'amqplib';
import { RequestHandler, Response } from 'express';
import { MessageUtilities } from './utilities/MessageUtilities';
import { ErrorCodes } from './constants/ErrorCodes';
import { constants } from 'http2';
import { EntityResolver } from './resolver/EntityResolver';
import { MessageValidator } from '@uems/uemscommlib';
import * as util from 'util';
import { _byFile, _byFileWithTag, _ml } from './log/Log';

const _l = _byFile(__filename);
const _t = _byFileWithTag(__filename, 'terminator');

const magenta = (input: string) => `\u001b[35m${input}\u001b[39m`;

// The queue of messages being sent from the microservices back to the gateway.
const RCV_INBOX_QUEUE_NAME: string = 'inbox';

// The exchange used for sending messages back to the gateway(s).
const GATEWAY_EXCHANGE: string = 'gateway';

// The exchange used for fanning / distributing requests out to the microservices.
const REQUEST_EXCHANGE: string = 'request';

type OutStandingReq = {
    unique_id: Number,
    response: Response,
    callback: Function,
    // TODO: Timestamp.
};

export namespace GatewayMk2 {
    export type MinimalMessageType = {
        msg_id: number,
        status: number,
    } & Record<string, any>;

    export type RequestCallback = (
        http: Response,
        timestamp: number,
        response: MinimalMessageType,
        status: number,
    ) => void;

    type PendingRequest = {
        uid: number,
        response: Response,
        callback: RequestCallback,
        timestamp: number,
        additionalValidator?: MessageValidator,
    };

    export type SendRequestFunction = (
        key: string,
        message: { msg_id: number, [key: string]: any },
        response: Response,
        callback: RequestCallback,
    ) => Promise<boolean>;

    export type GatewayInterfaceActionType = {
        action: 'get' | 'delete' | 'post' | 'patch',
        path: string,
        handle: RequestHandler,
        additionalValidator?: MessageValidator,
        secure?: boolean,
    };

    export class GatewayMessageHandler {
        /**
         * Active connection to the amqplib messaging system
         */
        private connection: Connection_;

        /**
         * The channel on which requests should be sent out to the microservices
         */
        private sendChannel?: Channel;

        /**
         * The channel on which requests should be received from the microservices
         */
        private receiveChannel?: Channel;

        /**
         * The current cache of outstanding requests which are awaiting being resolved
         */
        private outstandingRequests: Map<number, PendingRequest>;

        /**
         * The basic validator to be run against incoming messages, before entry specific validators are executed
         */
        private basicValidator: MessageValidator | undefined;

        /**
         * The interval bound to the terminator function which closes requests after minimum amounts of time
         * @private
         */
        private terminatorInterval: NodeJS.Timeout;

        /**
         * The entity resolver instance which will be used to intercept results for resolved entities
         * @private
         */
        private _resolver?: EntityResolver;

        /**
         * Creates a gateway, no side effects. Marked private as the async setup function should be used instead for
         * better handling.
         * @param connection the connection to the amqplib server
         * @param basicValidator the basic validator to be run against incoming messages
         * @private
         */
        public constructor(
            connection: Connection_,
            basicValidator: MessageValidator | undefined,
        ) {
            this.connection = connection;
            this.outstandingRequests = new Map<number, PendingRequest>();
            this.basicValidator = basicValidator;

            this.terminatorInterval = setInterval(this.terminateTimedOut, 2000);

            _l.info('created Gateway and scheduled terminator');
        }

        /**
         * Terminates requests after 15 seconds of waiting. Will free up in use keys as well
         * @private
         */
        private readonly terminateTimedOut = () => {
            const now = new Date().getTime();

            for (const key of this.outstandingRequests.keys()) {
                const entry = this.outstandingRequests.get(key);
                if (entry !== undefined && now - entry.timestamp > 15000) {
                    _t.debug(`terminating request ${entry.uid}@${entry.timestamp}`);

                    // The request has been waiting more than 15 seconds so we tell them that it has timed out
                    entry.response.status(constants.HTTP_STATUS_GATEWAY_TIMEOUT)
                        .json(MessageUtilities.wrapInFailure(ErrorCodes.SERVICE_TIMEOUT));

                    // Then remove this request from the outstanding requests
                    this.outstandingRequests.delete(key);

                    // And free up its message ID
                    MessageUtilities.identifierConsumed(entry.uid);
                }
            }
        };

        set resolver(value: EntityResolver) {
            this._resolver = value;
        }

        public async configure(resolver: EntityResolver) {
            this._resolver = resolver;
            try {
                this.sendChannel = await this.connection.createChannel();
            } catch (e) {
                _l.error('[gateway setup]: failed to initialise due to failing to create the channel');
                throw e;
            }
            _l.debug('send channel has been created');

            // Now make sure the exchange we're sending requests to exists
            try {
                await this.sendChannel.assertExchange(REQUEST_EXCHANGE, 'topic', {
                    durable: false,
                });
            } catch (e) {
                _l.error(`[gateway setup]: failed to initialise due to failing to 
                assert the exchange (${REQUEST_EXCHANGE})`);
                throw e;
            }
            _l.debug(`asserted the exchange ${REQUEST_EXCHANGE}`);

            // And then try to create another channel for receiving on
            try {
                this.receiveChannel = await this.connection.createChannel();
            } catch (e) {
                _l.error('[gateway setup]: failed to initialise due to failing to create the receiving channel');
                throw e;
            }
            _l.debug('created receive channel');

            // Then try to assert the gateway
            try {
                await this.receiveChannel.assertExchange(GATEWAY_EXCHANGE, 'direct');
            } catch (e) {
                _l.error(`[gateway setup]: failed to initialise due to failing to assert the gateway exchange 
                (${GATEWAY_EXCHANGE})`);
                throw e;
            }
            _l.debug(`asserted gateway exchange ${GATEWAY_EXCHANGE}`);

            // And the inbox queue
            try {
                await this.receiveChannel.assertQueue(RCV_INBOX_QUEUE_NAME, { exclusive: true });
            } catch (e) {
                _l.error(`[gateway setup]: failed to initialise due to failing to assert the inbox queue 
                (${RCV_INBOX_QUEUE_NAME})`);
                throw e;
            }
            _l.debug(`asserted inbox of ${RCV_INBOX_QUEUE_NAME}`);

            // Then bind the inbox to the exchange
            try {
                await this.receiveChannel.bindQueue(RCV_INBOX_QUEUE_NAME, GATEWAY_EXCHANGE, '');
            } catch (e) {
                _l.error(`[gateway setup]: failed to initialise due to failing to bind the inbox 
                (${RCV_INBOX_QUEUE_NAME}) to the exchange (${GATEWAY_EXCHANGE})`);
                throw e;
            }
            _l.debug(`created binding ${RCV_INBOX_QUEUE_NAME} --> ${GATEWAY_EXCHANGE}`);

            try {
                // And bind the incoming messages to the handler
                await this.receiveChannel.consume(RCV_INBOX_QUEUE_NAME, this.handleRawIncoming.bind(this), {
                    noAck: true,
                });
                _l.info('rabbit mq connection configured, consuming messages');
            } catch (e) {
                _l.error('[gateway setup]: failed to initialise due to failing to begin consuming');
                throw e;
            }
        }

        private readonly handleRawIncoming = (message: Message | null) => {
            if (this._resolver === undefined) throw new Error('Gateway not configured properly, no resolver');

            if (message === null) {
                _l.warn('[gateway raw incoming]: null message received, ignoring it');
                return;
            }

            const stringContent = message.content.toString('utf8');
            const json = JSON.parse(stringContent);

            if (!MessageUtilities.has(json, 'msg_id') || typeof (json.msg_id) !== 'number') {
                _l.warn('[gateway raw incoming]: message was received without an ID. Ignoring');
                return;
            }
            if (!MessageUtilities.has(json, 'status') || typeof (json.status) !== 'number') {
                _l.warn('[gateway raw incoming]: message was received without a status. Ignoring');
                return;
            }

            _l.debug(`incoming message @ ${json.msg_id} (${json.status})`);

            // If this message ID has been sent by the resolver, it will mark it as requiring an intercept
            // in that case we want to send it to it to be consumed
            if (this._resolver.intercept(json.msg_id)) {
                MessageUtilities.identifierConsumed(json.msg_id);
                this._resolver.consume(json);
                return;
            }

            const request = this.outstandingRequests.get(json.msg_id);
            if (request === undefined) {
                _l.warn('[gateway raw incoming]: message was received that did not match a pending '
                    + 'request. has it already timed out?', json.msg_id);
                return;
            }

            this.outstandingRequests.delete(json.msg_id);

            if (request.additionalValidator !== undefined) {
                request.additionalValidator.validate(json)
                    .then((validated) => {
                        if (validated) {
                            request.callback(request.response, request.timestamp, json, json.status);
                        } else {
                            _l.warn('[gateway raw incoming]: message was rejected because it didn\'t '
                                + 'pass the additional validator');
                        }
                    })
                    .catch((err) => {
                        _l.error(
                            '[gateway raw incoming]: message was rejected because the validator errored out',
                            err,
                        );
                    });
            } else {
                request.callback(request.response, request.timestamp, json, json.status);
            }
        };

        public publish(key: string, data: any) {
            if (this.sendChannel === undefined) {
                throw new Error('Gateway is not configured, make sure you have called configure');
            }

            console.log(magenta(`transmitting to ${key}: `), util.inspect(data, false, null, true));
            if (data.userID === undefined) console.trace('undefined userID');

            return this.sendChannel.publish(REQUEST_EXCHANGE, key, Buffer.from(JSON.stringify(data)));
        }

        public readonly sendRequest = async (
            key: string,
            message: { msg_id: number, [key: string]: any },
            response: Response,
            callback: RequestCallback,
            validator?: MessageValidator,
        ) => {
            this.outstandingRequests.set(message.msg_id, {
                response,
                callback,
                uid: message.msg_id,
                timestamp: new Date().getTime(),
                additionalValidator: validator,
            });

            return this.publish(key, message);
        };
    }

    export interface GatewayAttachmentInterface {

        generateInterfaces(
            send: SendRequestFunction,
            resolver: EntityResolver,
        ): GatewayInterfaceActionType[] | Promise<GatewayInterfaceActionType[]>;

    }
}
