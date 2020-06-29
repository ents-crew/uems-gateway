import { Channel, Connection, Message, Replies } from 'amqplib/callback_api';
import { Response, Request, NextFunction } from 'express';
import AssertQueue = Replies.AssertQueue;

// Handles receiving a HTTP REST request and processing that into a message
// to be sent onto a microservice.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseGetEventRequestToMessage(req: Request) {
    // TODO, currently returns blank - 'get all' type message.
    const msg = {
        ID: Math.random() * 100000,
        name: '',
        start_date_before: '',
        start_date_after: '',
        end_date_before: '',
        end_date_after: '',
    };
    return msg;
}

// The queue of messages being sent from the microservices back to the gateway.
const RCV_INBOX_QUEUE_NAME: string = 'inbox';

// The exchange used for sending messages back to the gateway(s).
const GATEWAY_EXCHANGE: string = 'gateway';

// The exchange used for fanning / distributing requests out to the microservices.
const REQUEST_EXCHANGE: string = 'request';

// The topic used for sending get requests to the event details microservice.
const EVENT_DETAILS_SERVICE_TOPIC_GET: string = 'events.details.get';

type OutStandingReq = {
    unique_id: Number,
    response: Response,
    callback: Function,
    // TODO: Timestamp.
};

export class GatewayMessageHandler {
    // Connection to the RabbitMQ messaging system.
    conn: Connection;

    // Channel for sending messages out to the microservices and receiving them back as a response.
    send_ch: Channel;

    rcv_ch: Channel;

    // Messages which have been sent on and who's responses are still being waited for.
    outstanding_reqs: Map<Number, OutStandingReq>;

    // Creates a GatewayMessageHandler.
    // Includes creating the channels, exchanges and queues on the connection required.
    //
    // Returns a promise which resolves to the new GatewayMessageHandler.
    static setup(conn: Connection): Promise<GatewayMessageHandler> {
        return new Promise(((resolve, reject) => {
            conn.createChannel((err1, sendCh) => {
                if (err1) {
                    reject(err1);
                }

                sendCh.assertExchange(REQUEST_EXCHANGE, 'topic', {
                    durable: false,
                });
                conn.createChannel((err2, rcvCh) => {
                    if (err2) {
                        reject(err2);
                    }

                    rcvCh.assertExchange(GATEWAY_EXCHANGE, 'direct');

                    rcvCh.assertQueue(RCV_INBOX_QUEUE_NAME, { exclusive: true }, (err3, queue) => {
                        if (err3) {
                            reject(err3);
                        }

                        console.log('Binding rcv inbox queue...');

                        rcvCh.bindQueue(RCV_INBOX_QUEUE_NAME, GATEWAY_EXCHANGE, '');

                        const mh = new GatewayMessageHandler(conn, sendCh, rcvCh, queue);

                        rcvCh.consume(queue.queue, (msg) => {
                            if (msg === null) {
                                console.warn(`${RCV_INBOX_QUEUE_NAME} consumed a message that was NULL. Ignoring...`);
                                return;
                            }

                            mh.gatewayInternalMessageReceived(mh, msg);
                        }, { noAck: true });

                        resolve(mh);
                    });
                });
            });
        }));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private constructor(conn: Connection, sendCh: Channel, rcvCh: Channel, rcvQueue: AssertQueue) {
        this.conn = conn;
        this.send_ch = sendCh;
        this.rcv_ch = rcvCh;
        this.outstanding_reqs = new Map();
    }

    // Called whenever a message is received by the gateway from the internal microservices.
    gatewayInternalMessageReceived(mh: GatewayMessageHandler, msg: Message) {
        const content = msg.content.toString('utf8');
        // TODO: This is a potential security weakness point - message parsing -> json injection attacks.

        // TODO: checks for message integrity.

        console.log('Internal message received');
        const msgJson = JSON.parse(content);

        console.log('MH: ', mh);

        const correspondingReq = mh.outstanding_reqs.get(msgJson.ID);
        if (correspondingReq === undefined) {
            console.log('Request response received with unrecognised or already handled ID');
            return;
        }

        this.outstanding_reqs.delete(msgJson.ID);

        correspondingReq.callback(correspondingReq.response, msgJson.payload);
    }

    publishRequestMessage = async (data: any, key: string) => {
        this.send_ch.publish(REQUEST_EXCHANGE, key, Buffer.from(JSON.stringify(data)));
    };

    // Sends a request to the microservices system and waits for the response to come back.
    sendRequest = async (key: string, data: any, dataID: Number, res: Response) => {
        // Create an object which represents a request which has been sent on by the gateway to be handled
        // but is still awaiting a matching response.
        this.outstanding_reqs.set(dataID, {
            unique_id: dataID,
            response: res,
            callback(response: Response, responseJSON: string) {
                response.send(responseJSON);
            },
        });

        await this.publishRequestMessage(data, key);
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars,class-methods-use-this
    add_events_handler(req: Request, res: Response, next: NextFunction) {
        throw new Error('Unimplemented');
    }

    get_events_handler = async (req: Request, res: Response) => {
        const reqMessage = parseGetEventRequestToMessage(req);

        console.log('Get event request received');

        await this.sendRequest(EVENT_DETAILS_SERVICE_TOPIC_GET, reqMessage, reqMessage.ID, res);
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars,class-methods-use-this
    modify_events_handler(req: Request, res: Response, next: NextFunction) {
        throw new Error('Unimplemented');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars,class-methods-use-this
    remove_events_handler(req: Request, res: Response, next: NextFunction) {
        throw new Error('Unimplemented');
    }

    // eslint-disable-next-line class-methods-use-this
    close() {
        console.log('Closing GatewayMessageHandler...');
    }
}
