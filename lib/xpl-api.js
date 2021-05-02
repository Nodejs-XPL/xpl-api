/*jslint node: true, esversion: 6 */

const Dgram = require('dgram');
const Events = require('events');
const os = require('os');
const fs = require('fs');
const Semaphore = require('semaphore');
const Async = require('async');
const debug = require('debug')('xpl-api');

const NO_OP = function () {
};

class XplAPI extends Events.EventEmitter {
    constructor(configuration) {
        super();

        let hostName = os.hostname();
        if (hostName.indexOf('.') > 0) {
            hostName = hostName.substring(0, hostName.indexOf('.'));
        }

        configuration = configuration || {};
        this._configuration = configuration;

        this._keepMessageOrder = (configuration.keepMessageOrder === true);

        let xplLog = this._configuration.xplLog;
        if (xplLog === true) {
            this._log = console.log.bind(console);

        } else if (typeof (xplLog) === "function") {
            this._log = xplLog.bind(this);

        } else if (debug.enabled) {
            this._log = debug;
        }

        configuration.xplPort = configuration.xplPort || 3865;
        configuration.hubSupport = configuration.hubSupport || false;
        configuration.socketType = configuration.socketType || 'udp4';
        // configuration.ttl = 0;
        configuration.hubPingDelaySecond = configuration.hubPingDelaySecond || 60 * 4;
        configuration.xplSource = configuration.xplSource || "nodejs." + hostName +
            "-" + process.pid;
        configuration.xplTarget = configuration.xplTarget || "*";
        // configuration.promiscuousMode = configuration.promiscuousMode
        // configuration.log = true;

        this._broadcastOutputSocketSemaphore = Semaphore(1);
        this._broadcastInputSocketSemaphore = Semaphore(1);
        this._localSocketSemaphore = Semaphore(1);

        this._waitingMessages = [];

        if (!this._configuration.localAddress) {
            var nis = os.networkInterfaces();

            var family = (this._configuration.socketType == "udp6") ? "IPv6" : "IPv4";

            for (var name in nis) {
                var addrs = nis[name];

                for (var i = 0; i < addrs.length; i++) {
                    var addr = addrs[i];

                    if (addr.internal || addr.family != family) {
                        continue;
                    }

                    this._configuration.localAddress = addr.address;
                    break;
                }

                if (this._configuration.localAddress) {
                    break;
                }
            }

            if (!this._configuration.localAddress) {
                this._configuration.localAddress = (this._configuration.socketType == "udp6") ? "::1" : "127.0.0.1";
            }
        }
        if (!this._configuration.broadcastAddress) {
            let ba = this._configuration.localAddress;
            const idx = ba.lastIndexOf(".");
            if (idx > 0) {
                ba = ba.substring(0, idx) + ".255";
            }

            this._configuration.broadcastAddress = ba;
        }

        debug("constructor", "Computed configuration=", this._configuration);

        if (configuration.verbose) {
            this._log("localAddress=", this._configuration.localAddress, "broadcastAddress=", this._configuration.broadcastAddress);
        }
    }

    /**
     * Specify valid options for Commander command line
     *
     * @param {*} commander
     */
    static fillCommander(commander) {
        commander.option("--xplPort <port>", "Set the xpl port", parseInt);
        commander.option("--hubSupport", "Enable xpl hub support");
        commander.option("--socketType <socketType>", "Specify the type of socket (udp4/udp6)");
        commander.option("--broadcastAddress <address>", "Specify the broadcastAddress");
        commander.option("--hubPingDelaySecond <sec>", "Specify the delay between 2 hub heart beats in second", parseInt);
        commander.option("--xplSource <name>", "Specify the source in XPL message");
        commander.option("--xplTarget <name>", "Specify the target in XPL message");
        commander.option("--xplLog", "Verbose XPL layer");
    }

    /**
     * Default log method
     *
     * @private
     */
    _log() {
        // this function is replaced by the constructor
        console.log.apply(console, arguments);
    }

    /**
     * Start the XPL HUB
     *
     * @param {Function} callback
     * @private
     */
    _startHub(callback) {
        // return callback("no");

        debug("startHub", "Starting ... try to allocate port");
        this._getInputBroadcastSocket((error, socket, address) => {

            if (error) {
                this._log("startHub: Hub is not started ", error);

                return callback(error);
            }

            debug("startHub", "Hub started ", address, socket);

            this._hubClients = {};

            const processMessage = (message, address, buffer) => {
                debug("startHub", "Hub receive message from=", address, " message=", message);

                // XPL Message

                // An heart beat ? Register it

                const clients = this._hubClients;

                if (message.bodyName == "hbeat.app") {
                    const key = address.address + ":" + address.port;
                    const now = Date.now();
                    clients[key] = {
                        ttl: now + this._configuration.hubPingDelaySecond * 1000 * 2,
                        address: address.address,
                        port: address.port
                    };

                    debug("startHub", "Register new client", clients[key]);

                    return;
                }

                this._forwardMessage(clients, message, buffer, (error) => {
                    if (error) {
                        console.error("Forward error: ", error);
                    }
                });
            };

            this.on("message", processMessage);
            this.on("hub", processMessage);

            callback(null);
        });
    }

    /**
     * Forward a message to other XPL clients.
     *
     * @param clients
     * @param message
     * @param buffer
     * @param {Function} callback
     * @private
     */
    _forwardMessage(clients, message, buffer, callback) {
        const now = Date.now();

        this._getLocalSocket((error, socket) => {
            if (error) {
                debug("_forwardMessage", "Can not forward message to client ", error);

                callback(error);
                return;
            }

            debug("_forwardMessage", "Forward message to clients=", clients, " now=", now);

            Async.forEachOf(clients, (client, clientName, callback) => {
                if (client.ttl < now) {
                    debug("_forwardMessage", "DELETE hub client=", client);
                    delete clients[clientName];

                    callback();
                    return;
                }
                debug("_forwardMessage", "Process hub client=", client);

                debug("_forwardMessage", "Forward message to " + client.address + ":" + client.port +
                    " => " + message);

                socket.send(buffer, 0, buffer.length, client.port, client.address, (error) => {
                    if (error) {
                        console.error("Can not forward message. error=", error);
                    }

                    callback();
                });

            }, (error) => {
                if (error) {
                    console.error(error);
                    return callback(error);
                }

                debug("_forwardMessage", "Message forwarded to all clients");

                callback();
            });
        });
    }

    /**
     *
     * @param {Function} callback
     * @private
     */
    _connectHub(callback) {
        debug("_connectHub", "Try to connect to the hub ...");

        this._getOutputBroadcastSocket((err, socket, address) => {
            if (err) {
                this._log("Can not connect to the hub ...", err);
                return callback(err);
            }

            debug("_connectHub", "Connecting to the hub ...");

            this._hubInterval = setInterval(() => {
                this._hubPing(address, socket);

            }, this._configuration.hubPingDelaySecond * 1000);

            this._hubPing(address, socket);

            return callback(null, address);
        });
    }

    /**
     *
     * @param message
     * @param [headerName]
     * @param [target]
     * @param [source]
     * @returns {*|{}}
     * @private
     */
    _fillHeader(message, headerName, target, source) {
        message = message || {};

        if (source && /^;/.exec(source)) {
            source = this._configuration.xplSource + ' ' + source;
        }

        message.header = {
            hop: 1,
            source: source || this._configuration.xplSource,
            target: target || this._configuration.xplTarget
        };
        if (headerName) {
            message.headerName = headerName;
        }

        return message;
    }

    /**
     *
     * @param address
     * @param socket
     * @private
     */
    _hubPing(address, socket) {
        debug("_hubPing", "send heart beat !");
        let interval = Math.floor(this._configuration.hubPingDelaySecond / 60);
        if (interval < 1) {
            interval = 1;
        }

        const message = this._fillHeader({
            bodyName: "hbeat.app",
            body: {
                interval: interval,
                port: address.port,
                "remote-ip": address.address || this._configuration.localAddress
            }
        }, "xpl-stat");

        const buffer = this._xplMessageToBuffer(message);

        debug("_hubPing", "buffer=", buffer.toString(), " port=",
            this._configuration.xplPort, " address=",
            this._configuration.broadcastAddress);

        socket.send(buffer, 0, buffer.length, this._configuration.xplPort,
            this._configuration.broadcastAddress, (error, bytes) => {
                debug("_hubPing", "Send heart beat error=", error, "bytes=", bytes);
            });
    }

    /**
     * Bind the socket.
     * If messages are in the waiting pool, they will be sent.
     *
     * @param {Function} [callback]
     * @returns {Promise}
     */
    bind(callback) {
        const bcallback = callback;

        const promise = new Promise((resolved, rejected) => {

            let callback = function (error) {
                if (bcallback) {
                    bcallback(error);
                }

                if (error) {
                    return rejected(error);
                }

                resolved();
            };

            this.close();

            if (!this._configuration.hubSupport) {
                this._connectHub(callback);
                return;
            }

            this._startHub((error) => {
                if (error) {
                    this._log("Start Hub return error (a XPL-HUB is already launched ?)", error);
                    // A HUB is already present !

                    this._connectHub(callback);
                    return;
                }

                debug("bind", "Start Hub succeed");

                const waitingMessages = this._waitingMessages;
                this._waitingMessages = undefined;
                if (waitingMessages) {
                    Async.each(waitingMessages, (message, callback) => {
                        this.sendBufferMessage(message, callback);

                    }, () => {
                        debug("bind", "Messages sent !");

                        callback();
                    });

                    return;
                }

                // Hub created
                callback(null);
            });
        });

        return promise;
    }

    /**
     * Send a XPL message.
     *
     * If the socket is not bound (see #bind() method), the message will be stored in a waiting pool.
     *
     * @param {string} headerName
     * @param {Object} header
     * @param {string} bodyName
     * @param {Object} body
     * @param {Function} [callback]
     * @returns {Promise}
     */
    sendMessage(headerName, header, bodyName, body, callback) {
        const message = {
            headerName: headerName,
            header: header,
            bodyName: bodyName,
            body: body
        };

        return this.send(message, callback);
    }

    /**
     *
     * @param {Object} xplMessage - The message
     * @param {string} xplMessage.headerName - Header name
     * @param {Object} [xplMessage.header] - Header content
     * @param {string} [xplMessage.bodyName] - Body name
     * @param {Object} [xplMessage.body] - Body content
     * @returns {Buffer}
     * @private
     */
    _xplMessageToBuffer(xplMessage) {

        var message = xplMessage.headerName + "\n{\n";
        var header = xplMessage.header;
        if (header) {
            for (var n in header) {
                var h = this._encodeValue(header[n]);
                message += n + "=" + h + "\n";
            }
        }
        message += "}\n";

        if (xplMessage.bodyName) {
            message += xplMessage.bodyName + "\n{\n";

            var body = xplMessage.body;
            if (body) {
                for (var n2 in body) {
                    var b = this._encodeValue(body[n2]);
                    message += n2 + "=" + b + "\n";
                }
            }
            message += "}\n";
        }

        const buffer = new Buffer(message);

        return buffer;
    }

    /**
     * Send a XPL message
     *
     * If the socket is not bound (see #bind() method), the message will be stored in a waiting pool.
     *
     * @param {Object} xplMessage - The message
     * @param {string} xplMessage.headerName - Header name
     * @param {Object} [xplMessage.header] - Header content
     * @param {string} [xplMessage.bodyName] - Body name
     * @param {Object} [xplMessage.body] - Body content
     * @param {Function} [callback]
     * @return {Promise}
     */
    send(xplMessage, callback) {
        if (!xplMessage.headerName) {
            const e = new Error("Invalid XPL message format (no header name)");
            e.xplMessage = xplMessage;

            if (callback) {
                callback(e);
            }

            return Promise.reject(e);
        }

        const buffer = this._xplMessageToBuffer(xplMessage);

        const promise = new Promise((resolved, rejected) => {

            this.sendBufferMessage(buffer, (error, value1, value2) => {
                if (typeof (callback) === "function") {
                    callback(error, value1, value2);
                }

                if (error) {
                    rejected(error, value1, value2);
                    return;
                }

                resolved(value1, value2);
            });
        });

        return promise;
    }

    /**
     * Send the message
     *
     * If the socket is not bound (see #bind() method), the message will be stored in a waiting pool.
     *
     * @param {Buffer} buffer
     * @param {Function} callback
     * @returns {void}
     * @private
     */
    sendBufferMessage(buffer, callback) {

        if (this._waitingMessages) {
            if (debug.enabled) {
                debug("sendBufferMessage", "Delayed message=", buffer.toString());
            }

            this._waitingMessages.push(buffer);
            if (!callback) {
                return;
            }

            return callback(null);
        }

        if (debug.enabled) {
            debug("sendBufferMessage", "Send buffer message=", buffer.toString());
        }

        this._getOutputBroadcastSocket((error, socket) => {
            if (error) {
                if (!callback) {
                    this._log("xpl.SendBufferMessage: error=", error);
                    return;
                }
                return callback(error);
            }

            if (debug.enabled) {
                debug("sendBufferMessage", "Send buffer to", this._configuration.broadcastAddress, ":", this._configuration.xplPort);
            }

            socket.send(buffer, 0, buffer.length, this._configuration.xplPort,
                this._configuration.broadcastAddress, (error, bytes) => {
                    if (error) {
                        if (!callback) {
                            this._log("xpl.SendBufferMessage: error=", error);
                            return;
                        }
                        return callback(error);
                    }

                    if (!callback) {
                        return;
                    }
                    callback(null, socket);
                });
        });
    }

    /**
     *
     * @param {Function} callback
     * @returns {void}
     * @private
     */
    _getLocalSocket(callback) {

        this._getSocket(this._localSocketSemaphore, "_localSocket",
            this._configuration.localAddress, 0, false, callback);
    }

    /**
     *
     * @param {Function} callback
     * @returns {void}
     * @private
     */
    _getOutputBroadcastSocket(callback) {

        this._getSocket(this._broadcastOutputSocketSemaphore,
            "_outputBroadcastSocket",
            this._configuration.localAddress,
            0,
            true,
            callback);
    }

    /**
     *
     * @param {Function} callback
     * @returns {void}
     * @private
     */
    _getInputBroadcastSocket(callback) {

        const ba = (os.platform() == "win32") ? "" : this._configuration.broadcastAddress;

        this._getSocket(this._broadcastInputSocketSemaphore,
            "_inputBroadcastSocket", ba, this._configuration.xplPort, true, callback);
    }

    /**
     *
     * @param sem
     * @param cacheName
     * @param address
     * @param port
     * @param broadcastType
     * @param callback
     * @private
     * @returns {void}
     */
    _getSocket(sem, cacheName, address, port, broadcastType, callback) {

        if (debug.enabled) {
            debug("_getSocket", "cacheName=", cacheName, "get socket for address=", address, "port=", port, "broadcast=", broadcastType);
        }

        sem.take(() => {
            const socket = this[cacheName];
            if (socket) {
                sem.leave();
                return callback(null, socket, socket.address());
            }

            this._connect(address, port, broadcastType, (error, socket, address) => {
                if (debug.enabled) {
                    debug("_getSocket", "cacheName=", cacheName, "Connection result error=",
                        error, "address=", address);
                }

                if (error) {
                    this[cacheName] = null;
                    sem.leave();
                    return callback(error);
                }

                this[cacheName] = socket;
                sem.leave();

                callback(null, socket, address);
            });
        });
    }

    /**
     *
     * @param address
     * @param port
     * @param broadcastType
     * @param callback
     * @returns {void}
     * @private
     */
    _connect(address, port, broadcastType, callback) {

        const config = this._configuration;

        let closeState = false;

        debug("_connect", "address=", address, "port=", port, "broadcastType=", broadcastType);

        const socket = Dgram.createSocket(config.socketType);

        let listening = false;

        socket.on("close", () => {
            closeState = true;
        });

        socket.on("message", (buffer, address) => {
            const message = buffer.toString();

            let packet;

            try {
                packet = this._parseXPLMessage(message, address);

            } catch (x) {

                if (debug.enabled) {
                    debug("_connect", "Can not validate packet message=", message, " from=", address,
                        " error=", x);
                }

                this.emit("validationError", x, message, address);
                return;
            }

            if (!config.promiscuousMode) {
                if (packet.header) {
                    const target = packet.header.target;

                    if (target && target !== '*' && target !== config.xplSource) {
                        debug("_connect", "Ignore packet=", packet, " from=", address);

                        if (this._hubClients) {
                            // Hub mode !

                            this.emit("hub", packet, address, buffer);
                        }

                        return;
                    }
                }
            }

            if (packet) {

                if (debug.enabled) {
                    debug("_connect", "Emit received packet=", packet, "from=", address.address, ":", address.port);
                }

                this.emit("message", packet, address, buffer);

                if (packet.headerName) {
                    this.emit("xpl:" + packet.headerName, packet, address);
                }
                if (packet.bodyName) {
                    this.emit("xpl:" + packet.bodyName, packet, address);
                }
            }
        });

        socket.on("error", (error) => {
            this._log("_connect: socket error", error, error.stack);
            socket.close();

            if (!listening) {
                return callback(error, null);
            }

            this.emit("error", error);
        });

        if (config.ttl) {
            socket.setTTL(config.ttl);
            debug("_connect", "Socket: set TTL to", config.ttl);
        }

        debug("_connect", "bind address=", address, " port=", port);

        socket.on("listening", (error) => {
            if (closeState) {
                return callback(new Error("Socket closed"));
            }

            if (error) {
                this._log("Socket bind failed error=", error);

                return callback(error);
            }

            if (listening) {
                return;
            }

            if (broadcastType) {
                socket.setBroadcast(true);
                debug("_connect", "Socket: set broadcast type to TRUE");
            }

            listening = true;

            const address = socket.address();

            debug("_connect", "Bind succeed on", address.address, ":", address.port);

            const waitingMessages = this._waitingMessages;
            this._waitingMessages = undefined;
            if (waitingMessages) {
                return Async.each(waitingMessages, (message, callback) => {

                    this.sendBufferMessage(message, callback);

                }, (error) => {
                    callback(error, socket, address);
                });
            }

            callback(null, socket, address);
        });

        socket.bind(port, address);
    }

    /**
     * Close the connexion
     *
     * @param {Function} [callback]
     * @returns {Promise}
     */
    close(callback) {
        const promise = new Promise((resolved, rejected) => {

            if (this._hubInterval) {
                clearInterval(this._hubInterval);
                this._hubInterval = undefined;
            }

            let somethingClosed = false;

            if (this._localSocket) {
                this._localSocket.close();
                this._localSocket = undefined;
                somethingClosed = true;
            }
            if (this._inputBroadcastSocket) {
                this._inputBroadcastSocket.close();
                this._inputBroadcastSocket = undefined;
                somethingClosed = true;
            }
            if (this._outputBroadcastSocket) {
                this._outputBroadcastSocket.close();
                this._outputBroadcastSocket = undefined;
                somethingClosed = true;
            }

            if (somethingClosed) {
                this.emit("close");
            }

            this._hubClients = undefined;

            if (callback) {
                callback();
            }

            resolved();
        });
        return promise;
    }

    /**
     * Parse XPL message
     *
     * @param {string} buffer
     * @param {Object} address
     * @returns {{timestamp: number, from: Object}}
     * @private
     */
    _parseXPLMessage(buffer, address) {
        const lines = buffer.replace(/\r/gm, "").split("\n");

        const dest = {
            timestamp: Date.now(),
            from: address,
        };
        this._parseXPLBlock(dest, "headerName", "header", lines);
        this._parseXPLBlock(dest, "bodyName", "body", lines);

        const headSchemas = this._headSchemas;
        if (headSchemas) {
            const headSchema = headSchemas[dest.headName];
            if (headSchema) {
                this._validSchema(headSchema, dest.head);
            }
        }

        let validated = false;
        const bodySchemas = this._bodySchemas;
        if (bodySchemas) {
            const bodySchema = bodySchemas[dest.bodyName];
            if (bodySchema) {
                this._validSchema(bodySchema, dest.body);
                validated = true;
            }
        }

        if (this._configuration.forceBodySchemaValidation && !validated) {
            const e = new Error("No body schema for '" + dest.bodyName + "'.");
            e.code = "NO_BODY_SCHEMA";
            throw e;
        }

        return dest;
    }

    /**
     * Parse a XPL block
     *
     * @param {Object} dest
     * @param {string} blockName
     * @param {string} blockVar
     * @param {string[]} lines
     * @private
     */
    _parseXPLBlock(dest, blockName, blockVar, lines) {
        dest[blockName] = lines.shift();
        if (lines.shift() != "{") {
            return;
        }
        const header = {};
        let order = null;
        if (this._keepMessageOrder) {
            order = [];
            dest.$order = order;
        }
        dest[blockVar] = header;
        for (; ;) {
            const line = lines.shift();
            if (line == "}") {
                break;
            }
            const r = /^([^=]+)=(.*)$/.exec(line);
            if (!r) {
                continue;
            }
            const name = r[1];
            const value = this._decodeValue(r[2]);

            if (order) {
                order.push(name);
            }
            header[name] = value;
        }
    }

    /**
     *
     * @param {string|*} text
     * @returns {string}
     * @private
     */
    _encodeValue(text) {
        if (typeof (text) !== "string") {
            return text;
        }
        text = text.replace(/\\/g, '\\\\');
        text = text.replace(/\n/g, '\\n');

        return text;
    }

    /**
     *
     * @param {string} text
     * @returns {string}
     * @private
     */
    _decodeValue(text) {
        text = text.replace(/\\n/g, '\n');
        text = text.replace(/\\\\/g, '\\');

        return text;
    }

    /**
     *
     * @param body
     * @param bodyName
     * @param callback
     * @param [headerName]
     * @param [target]
     * @param [source]
     * @return {Promise}
     * @private
     */
    _sendXplX(body, bodyName, callback, headerName, target, source) {

        const message = this._fillHeader({
            bodyName: bodyName,
            body: body
        }, headerName, target, source);

        return this.send(message, callback);
    }

    /**
     * Send a XPL command
     *
     * @param {string} command
     * @param {Object} body
     * @param {string} [bodyName]
     * @param {string} [target]
     * @param {string} [source]
     * @param {Function} [callback]
     * @return {Promise}
     */
    sendXplCommand(command, body, bodyName, target, source, callback) {
        if (typeof (source) === "function") {
            callback = source;
            source = null;
        }
        if (typeof (target) === "function") {
            callback = target;
            target = null;
        }
        if (typeof (bodyName) === "function") {
            callback = bodyName;
            bodyName = null;
        }

        return this._sendXplX(body, bodyName, callback, command, target, source);
    }

    /**
     * Send a XPL Stat message
     *
     * @param {Object} body
     * @param {string} [bodyName='sensor.basic']
     * @param {string} [target]
     * @param {string} [source]
     * @param {Function} callback
     * @return {Promise}
     */
    sendXplStat(body, bodyName, target, source, callback) {
        if (arguments.length === 4 && typeof (source) === "function") {
            callback = source;
            source = null;
        }
        if (arguments.length === 3 && typeof (target) === "function") {
            callback = target;
            target = null;
        }
        if (arguments.length === 2 && typeof (bodyName) === "function") {
            callback = bodyName;
            bodyName = null;
        }

        if (!bodyName || typeof (bodyName) !== "string") {
            bodyName = "sensor.basic";
        }

        return this._sendXplX(body, bodyName, callback, "xpl-stat", target, source);
    }

    /**
     * Send a XPL Trig message
     *
     * @param {Object} body
     * @param {string} [bodyName='sensor.basic']
     * @param {string} [target]
     * @param {string} [source]
     * @param {Function} [callback]
     * @return {Promise}
     */
    sendXplTrig(body, bodyName, target, source, callback) {
        if (arguments.length === 4 && typeof (source) === "function") {
            callback = source;
            source = null;
        }
        if (arguments.length === 3 && typeof (target) === "function") {
            callback = target;
            target = null;
        }
        if (arguments.length === 2 && typeof (bodyName) === "function") {
            callback = bodyName;
            bodyName = null;
        }

        if (!bodyName || typeof (bodyName) !== "string") {
            bodyName = "sensor.basic";
        }

        return this._sendXplX(body, bodyName, callback, "xpl-trig", target, source);
    }

    /**
     * Send a XPL command
     *
     * @param {Object} body
     * @param {string} [bodyName='sensor.basic']
     * @param {string} [target]
     * @param {string} [source]
     * @param {Function} [callback]
     * @return {Promise}
     */
    sendXplCmnd(body, bodyName, target, source, callback) {
        if (arguments.length === 4 && typeof (source) === "function") {
            callback = source;
            source = null;
        }
        if (arguments.length === 3 && typeof (target) === "function") {
            callback = target;
            target = null;
        }
        if (arguments.length === 2 && typeof (bodyName) === "function") {
            callback = bodyName;
            bodyName = null;
        }

        if (!bodyName || typeof (bodyName) !== "string") {
            bodyName = "sensor.request";
        }

        return this._sendXplX(body, bodyName, callback, "xpl-cmnd", target, source);
    }

    /**
     * Add Schema for a specific header name.
     *
     * @param {string} headName
     * @param {Object} schema
     * @returns {void}
     */
    addHeadSchema(headName, schema) {
        var headSchemas = this._headSchemas;
        if (!headSchemas) {
            headSchemas = {};
            this._headSchemas = headSchemas;
        }

        headSchemas[headName] = schema;
    }

    /**
     * Add Schema for a specific body name.
     *
     * @param {string} bodyName
     * @param {Object} schema
     * @returns {void}
     */
    addBodySchema(bodyName, schema) {
        var bodySchemas = this._bodySchemas;
        if (!bodySchemas) {
            bodySchemas = {};
            this._bodySchemas = bodySchemas;
        }

        bodySchemas[bodyName] = schema;
    }

    /**
     * Valid schema for an object
     *
     * @param schema
     * @param obj
     * @returns {void}
     * @private
     */
    _validSchema(schema, obj) {

        for (var fieldName in obj) {
            var desc = schema.properties[fieldName];
            if (!desc) {
                let e = new Error("Unknown field '" + fieldName + "'");
                e.code = "UNKNOWN_FIELD";
                throw e;
            }

            var value = obj[fieldName];
            if (value === undefined) {
                let e = new Error("Field '" + fieldName + "' has not value");
                e.code = "NO_VALUE";
                throw e;
            }

            var newValue;

            switch (desc.type) {
                case "integer":
                case "float":
                case "number":
                    newValue = (desc.type === "integer") ? parseInt(value, 10) : parseFloat(value);

                    if (isNaN(newValue)) {
                        let e = new Error("Invalid integer field='" + fieldName + "' value=" + value);
                        e.code = "NOT_A_NUMBER";
                        throw e;
                    }
                    if (typeof (desc.minimum) === 'number') {
                        if (newValue < desc.minimum) {
                            let e = new Error("Invalid range of integer field='" + fieldName + "' value=" + value + " minimum=" + desc.minimum);
                            e.code = "RANGER_ERROR";
                            throw e;
                        }
                    }
                    if (typeof (desc.maximum) === 'number') {
                        if (newValue > desc.maximum) {
                            let e = new Error("Invalid range of integer field='" + fieldName + "' value=" + value + " maximum=" + desc.maximum);
                            e.code = "RANGER_ERROR";
                            throw e;
                        }
                    }
                    obj[fieldName] = newValue;
                    break;

                case "boolean":
                    var v = value.toLowerCase();
                    obj[fieldName] = !(v == "f" || v == "0" || v == "false" || v == "no" || v == "n" || v == "[]");
                    break;

                case "string":
                    var pattern = desc.pattern;
                    if (pattern) {
                        if (typeof (pattern) === "string") {
                            pattern = new RegExp(pattern);
                            desc.pattern = pattern;
                        }

                        if (!pattern.test(value)) {
                            let e = new Error("Regexp has not matched field='" + fieldName + "' value=" + value + " regExp=" + pattern);
                            e.code = "REGEXP_NOT_MATCHED";
                            throw e;
                        }
                    }

                    var _enum = desc.enum;
                    if (_enum && _enum.indexOf) {
                        if (_enum.indexOf(value) < 0) {
                            let e = new Error("String is not in the enum field='" + fieldName + "' value=" + value + " enum=" + _enum);
                            e.code = "NOT_IN_ENUM";
                            throw e;
                        }
                    }
                    break;

                default:
                    let e = new Error("Type is not implemented '" + desc.type + "'");
                    e.code = "NOT_IMPLEMENTED";
                    throw e;
            }
        }

        if (schema.required) {
            schema.required.forEach((name) => {
                if (!(name in obj)) {
                    let e = new Error("Required field not specified fieldName='" + name + "'");
                    e.code = "REQUIRED_FIELD_NOT_SPECIFIED";
                    throw e;
                }
            });
        }
    }

    static _loadDeviceAliasesFile(file, ds, configuration) {
        function load(reload) {
            debug("_loadDeviceAliasesFile", "load file content: path=", file);
            fs.readFile(file, (error, data) => {
                if (error) {
                    console.error("Can not load device aliases=", file, "error=", error);

                    if (reload) {
                        setTimeout(load, 2000);
                    }
                    return;
                }

                let r;
                try {
                    r = JSON.parse(data);
                } catch (x) {
                    console.error('Can not parse JSON of file ', file, 'parsing error=', x);

                    if (reload) {
                        setTimeout(load, 2000);
                    }
                    return;
                }

                for (let n in r) {
                    if (!r.hasOwnProperty(n)) {
                        continue;
                    }
                    ds[n] = r[n];
                }
            });
        }

        function load0() {
            setTimeout(() => {
                load(true);
            }, 300);
        }

        fs.watch(file, load0);

        load();
    }

    /**
     * Load device aliases
     *
     *
     * @param deviceAliases
     * @returns {{}}
     */
    static loadDeviceAliases(deviceAliases, configuration) {
        const ds = {};
        if (!deviceAliases) {
            return ds;
        }

        if (deviceAliases.indexOf('=') >= 0) {
            const js = deviceAliases.split(',');
            for (let i = 0; i < js.length; i++) {
                const j = js[i].split('=');
                if (j.length === 2) {
                    ds[j[0].trim()] = j[1].trim();
                }
            }

            debug("DeviceAliases=", ds);
            return ds;
        }

        deviceAliases.split(",").forEach((path) => {
            XplAPI._loadDeviceAliasesFile(path, ds, configuration);
        });

        debug("loadDeviceAliases", "DeviceAliases=", deviceAliases, "=>", ds);

        return ds;
    }
}

module.exports = XplAPI;
