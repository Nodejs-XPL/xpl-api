/*jslint node: true, vars: true, nomen: true*/
'use strict';

var Dgram = require('dgram');
var Underscore = require('underscore');
var Events = require('events');
var Util = require('util');
var os = require('os');
var Semaphore = require('semaphore');
var Async = require('async');

var XplAPI = function(configuration) {
	Events.EventEmitter.call(this);

	var hostName = os.hostname();
	if (hostName.indexOf('.') > 0) {
		hostName = hostName.substring(0, hostName.indexOf('.'));
	}

	configuration = Underscore.clone(configuration || {});
	this._configuration = configuration;

	configuration.xplPort = configuration.xplPort || 3865;
	configuration.hubSupport = configuration.hubSupport || false;
	configuration.socketType = configuration.socketType || 'udp4';
	// configuration.ttl = 0;
	configuration.hubPingDelaySecond = configuration.hubPingDelaySecond || 60 * 4;
	configuration.xplSource = configuration.xplSource || "nodejs." + hostName + "-" + process.pid;
	configuration.xplTarget = configuration.xplTarget || "*";
	// configuration.log = true;

	this._broadcastOutputSocketSemaphore = Semaphore(1);
	this._broadcastInputSocketSemaphore = Semaphore(1);
	this._localSocketSemaphore = Semaphore(1);
	
	this._waitingMessages = [];

	if (!this._configuration.localAddress) {
		var nis = os.networkInterfaces();

		var family = (this._configuration.socketType == "udp6") ? "IPv6" : "IPv4";

		for ( var name in nis) {
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
		var ba = this._configuration.localAddress;
		var idx = ba.lastIndexOf(".");
		if (idx > 0) {
			ba = ba.substring(0, idx) + ".255";
		}

		this._configuration.broadcastAddress = ba;
	}

	this._log("localAddress=", this._configuration.localAddress, " broadcastAddress=",
			this._configuration.broadcastAddress);
};

Util.inherits(XplAPI, Events.EventEmitter);
module.exports = XplAPI;

XplAPI.fillCommander = function(commander) {
	commander.option("--xplPort <port>", "Set the xpl port", parseInt);
	commander.option("--hubSupport", "Enable xpl hub support");
	commander.option("--socketType <socketType>", "Specify the type of socket (udp4/udp6)");
	commander.option("--broadcastAddress <address>", "Specify the broadcastAddress");
	commander.option("--hubPingDelaySecond <sec>", "Specify the delay between 2 hub heart beats in second", parseInt);
	commander.option("--xplSource <name>", "Specify the source in XPL message");
	commander.option("--xplTarget <name>", "Specify the target in XPL message");
	commander.option("--xplLog", "Verbose XPL layer");
};

XplAPI.prototype._log = function() {
	if (!this._configuration.xplLog) {
		return;
	}

	console.log.apply(console, arguments);
};

XplAPI.prototype._startHub = function(callback) {
	// return callback("no");
	var self = this;

	this._log("startHub: try to allocate port");
	this._getInputBroadcastSocket(function(error, socket, address) {

		if (error) {
			self._log("startHub: Hub is not started ", error);

			return callback(error);
		}

		self._log("startHub: Hub started ", address, socket);

		self._hubClients = {};

		self.on("messsage", function(message, address) {
			self._log("Hub receive message from=", address, " message=", message);

			// XPL Message

			// An heart beat ? Register it

			var clients = self._hubClients;

			if (message.bodyName == "hbeat.app") {
				var key = address.address + ":" + address.port;
				var now = Date.now();
				clients[key] = {
					ttl: now + self._configuration.hubPingDelaySecond * 1000,
					address: address.address,
					port: address.port
				};

				return;
			}

			self._forwardMessage(clients, message);
		});

		return callback(null);
	});
};

XplAPI.prototype._forwardMessage = function(clients, message) {
	var now = Date.now();

	var self = this;
	function sendMessage(error) {
		if (error) {
			self._log("Can not forward message. error=", error);
			return;
		}

		self._log("Forward message to XXX");
	}

	this._getLocalSocket(function(error, socket) {
		if (error) {
			self._log("Can not forward message to client ", error);
			return;
		}

		for ( var clientName in clients) {
			var client = clients[clientName];

			if (client.ttl > now) {
				delete clients[clientName];
				continue;
			}

			socket.send(message, 0, message.length, client.port, client.address, sendMessage);
		}
	});
};

XplAPI.prototype._connectHub = function(callback) {
	this._log("Try to connect to the hub ...");

	var self = this;
	this._getOutputBroadcastSocket(function(err, socket, address) {
		if (err) {
			return callback(err);
		}

		self._log("Connecting to the hub ...");

		self._hubInterval = setInterval(function() {
			self._hubPing(address, socket);

		}, self._configuration.hubPingDelaySecond * 1000);

		self._hubPing(address, socket);

		return callback(null, address);
	});

};

XplAPI.prototype._fillHeader = function(message, headerName) {
	message = message || {};
	message.header = {
		hop: 1,
		source: this._configuration.xplSource,
		target: this._configuration.xplTarget
	};
	if (headerName) {
		message.headerName = headerName;
	}

	return message;
};

XplAPI.prototype._hubPing = function(address, socket) {
	this._log("hubPing: send heart beat !");
	var interval = Math.floor(this._configuration.hubPingDelaySecond / 60);
	if (interval < 1) {
		interval = 1;
	}

	var message = this._fillHeader({
		bodyName: "hbeat.app",
		body: {
			interval: interval,
			port: address.port,
			"remote-ip": address.address || this._configuration.localAddress
		}
	}, "xpl-stat");

	var buffer = this._xplMessageToBuffer(message);

	this._log("hubPing: buffer=", buffer.toString(), " port=", this._configuration.xplPort, " address=",
			this._configuration.broadcastAddress);

	var self = this;
	socket.send(buffer, 0, buffer.length, this._configuration.xplPort, this._configuration.broadcastAddress, function(
			error, bytes) {
		self._log("Send heart beat error=", error);
	});

};

XplAPI.prototype.bind = function(callback) {
	this.close();

	var self = this;

	if (!this._configuration.hubSupport) {
		return this._connectHub(callback);
	}

	this._startHub(function(error) {
		if (error) {
			self._log("Start Hub return error (a XPL-HUB is already launched ?)", error);
			// A HUB is already present !

			return self._connectHub(callback);
		}

		self._log("Start Hub succeed");

		var waitingMessages = self._waitingMessages;
		self._waitingMessages = undefined;
		if (waitingMessages) {
			return Async.each(waitingMessages, function(message, callback) {

				self.sendBufferMessage(message, callback);
			}, callback);
		}

		// Hub created
		return callback(null);
	});
};

XplAPI.prototype.sendMessage = function(headerName, header, bodyName, body, callback) {
	var message = {
		headerName: headerName,
		header: header,
		bodyName: bodyName,
		body: body
	};

	return this.send(message, callback);
};

XplAPI.prototype._xplMessageToBuffer = function(xplMessage) {

	var message = xplMessage.headerName + "\n{\n";
	if (xplMessage.header) {
		for ( var n in xplMessage.header) {
			message += n += "=" + xplMessage.header[n] + "\n";
		}
	}
	message += "}\n";

	if (xplMessage.bodyName) {
		message += xplMessage.bodyName + "\n{\n";
		if (xplMessage.body) {
			for ( var n2 in xplMessage.body) {
				message += n2 += "=" + xplMessage.body[n2] + "\n";
			}
		}
		message += "}\n";
	}

	var buffer = new Buffer(message);

	return buffer;
};

XplAPI.prototype.send = function(xplMessage, callback) {
	if (!xplMessage.headerName) {
		return callback(new Error("Invalid XPL message format ", xplMessage));
	}

	var buffer = this._xplMessageToBuffer(xplMessage);

	return this.sendBufferMessage(buffer, callback);
};

XplAPI.prototype.sendBufferMessage = function(buffer, callback) {

	if (this._waitingMessages) {
		this._log("Delayed message=", buffer.toString());

		this._waitingMessages.push(buffer);
		if (!callback) {
			return;
		}

		return callback(null);
	}

	this._log("Send buffer message=", buffer.toString());

	var self = this;

	this._getOutputBroadcastSocket(function(error, socket) {
		if (error) {
			if (!callback) {
				self._log("xpl.SendBufferMessage: error=", error);
				return;
			}
			return callback(error);
		}

		self._log("Send buffer to " + self._configuration.broadcastAddress + ":" + self._configuration.xplPort);

		socket.send(buffer, 0, buffer.length, self._configuration.xplPort, self._configuration.broadcastAddress, function(
				error, bytes) {
			if (error) {
				if (!callback) {
					self._log("xpl.SendBufferMessage: error=", error);
					return;
				}
				return callback(error);
			}

			if (!callback) {
				return;
			}
			return callback(null, socket);
		});
	});
};

XplAPI.prototype._getLocalSocket = function(callback) {

	return this._getSocket(this._localSocketSemaphore, "_localSocket", this._configuration.localAddress, 0, false,
			callback);
};

XplAPI.prototype._getOutputBroadcastSocket = function(callback) {

	return this._getSocket(this._broadcastOutputSocketSemaphore, "_outputBroadcastSocket",
			this._configuration.localAddress, 0, true, callback);
};

XplAPI.prototype._getInputBroadcastSocket = function(callback) {

	var ba = (os.platform() == "win32") ? "" : this._configuration.broadcastAddress;

	return this._getSocket(this._broadcastInputSocketSemaphore, "_inputBroadcastSocket", ba, this._configuration.xplPort,
			true, callback);
};

XplAPI.prototype._getSocket = function(sem, cacheName, address, port, broadcastType, callback) {

	var self = this;

	this._log("_getSocket: '" + cacheName + "' get socket for address=", address, " port=", port, " broadcast=",
			broadcastType);

	sem.take(function() {

		var socket = self[cacheName];
		if (socket) {
			sem.leave();
			return callback(null, socket, socket.address());
		}

		self._connect(address, port, broadcastType, function(error, socket, address) {
			self._log("_getSocket: '" + cacheName + "' Connection result error=", error, "address=", address);

			if (error) {
				self[cacheName] = null;
				sem.leave();
				return callback(error);
			}

			self[cacheName] = socket;
			sem.leave();

			return callback(null, socket, address);
		});
	});
};

XplAPI.prototype._connect = function(address, port, broadcastType, callback) {

	var config = this._configuration;

	var closeState = false;

	this._log("_connect: address=", address, " port=", port, " broadcastType=", broadcastType);

	var self = this;
	var socket = Dgram.createSocket(config.socketType);

	var listening = false;

	socket.on("close", function() {
		closeState = true;
	});

	socket.on("message", function(buffer, address) {
		var message = buffer.toString();

		var packet;

		try {
			packet = self._parseXPLMessage(message);

		} catch (x) {
			self._log("Can not validate packet message=", message, " from=", address, " error=", x);

			self.emit("validationError", x, message, address);
			return;
		}

		self._log("Receive packet=", packet, " from=", address);
		if (packet) {
			self.emit("message", packet, address);

			if (packet.headerName) {
				self.emit("xpl:" + packet.headerName, packet, address);
			}
			if (packet.bodyName) {
				self.emit("xpl:" + packet.bodyName, packet, address);
			}
		}
	});

	socket.on("error", function(error) {
		self._log("_connect: socket error", error, error.stack);
		socket.close();

		if (!listening) {
			return callback(error, null);
		}

		self.emit("error", error);
	});

	if (config.ttl) {
		socket.setTTL(config.ttl);
		this._log("Socket: set TTL to " + config.ttl);
	}

	this._log("_connect: bind address=", address, " port=", port);

	socket.on("listening", function(error) {
		if (closeState) {
			return callback("error", new Error("Socket closed"));
		}

		if (error) {
			self._log("Socket bind failed error=", error);

			return callback(error);
		}

		if (listening) {
			return;
		}

		if (broadcastType) {
			socket.setBroadcast(true);
			self._log("Socket: set broadcast type to TRUE");
		}

		listening = true;

		var address = socket.address();

		self._log("Bind succeed on " + address + ":" + address.port);

		var waitingMessages = self._waitingMessages;
		self._waitingMessages = undefined;
		if (waitingMessages) {
			return Async.each(waitingMessages, function(message, callback) {

				self.sendBufferMessage(message, callback);
			}, function(error) {
				callback(error, socket, address);
			});
		}

		callback(null, socket, address);
	});

	socket.bind(port, address);
};

XplAPI.prototype.close = function(callback) {
	if (this._hubInterval) {
		clearInterval(this._hubInterval);
		this._hubInterval = undefined;
	}

	var somethingClosed = false;

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

	return callback;
};

XplAPI.prototype._parseXPLMessage = function(buffer) {
	var lines = buffer.replace(/\r/gm, "").split("\n");

	var dest = {};
	this._parseXPLBlock(dest, "headerName", "header", lines);
	this._parseXPLBlock(dest, "bodyName", "body", lines);

	var headSchemas = this._headSchemas;
	if (headSchemas) {
		var headSchema = headSchemas[dest.headName];
		if (headSchema) {
			this._validSchema(headSchema, dest.head);
		}
	}

	var validated = false;
	var bodySchemas = this._bodySchemas;
	if (bodySchemas) {
		var bodySchema = bodySchemas[dest.bodyName];
		if (bodySchema) {
			this._validSchema(bodySchema, dest.body);
			validated = true;
		}
	}

	if (this.configuration.forceBodySchemaValidation && !validated) {
		var e = new Error("No body schema for '" + dest.bodyName + "'.");
		e.code = "NO_BODY_SCHEMA";
		throw e;
	}

	return dest;
};

XplAPI.prototype._parseXPLBlock = function(dest, blockName, blockVar, lines) {
	dest[blockName] = lines.shift();
	if (lines.shift() != "{") {
		return null;
	}
	var header = {};
	dest[blockVar] = header;
	for (;;) {
		var line = lines.shift();
		if (line == "}") {
			break;
		}
		var idx = line.indexOf('=');
		if (idx < 0) {
			continue;
		}
		var name = line.substring(0, idx);
		var value = line.substring(idx + 1);

		header[name] = value;
	}

};

XplAPI.prototype._sendXplX = function(body, bodyName, callback, headerName) {

	var message = this._fillHeader({
		bodyName: bodyName,
		body: body
	}, headerName);

	return this.send(message, callback);
};

XplAPI.prototype.sendXplStat = function(body, bodyName, callback) {
	callback = arguments[arguments.length - 1];
	if (typeof (callback) != "function") {
		callback = null;
	}
	if (!bodyName || typeof (bodyName) != "string") {
		bodyName = "sensor.basic";
	}

	return this._sendXplX(body, bodyName, callback, "xpl-stat");
};

XplAPI.prototype.sendXplTrig = function(body, bodyName, callback) {
	callback = arguments[arguments.length - 1];
	if (typeof (callback) != "function") {
		callback = null;
	}
	if (!bodyName || typeof (bodyName) != "string") {
		bodyName = "sensor.basic";
	}

	return this._sendXplX(body, bodyName, callback, "xpl-trig");
};

XplAPI.prototype.sendXplCmnd = function(body, bodyName, callback) {
	callback = arguments[arguments.length - 1];
	if (typeof (callback) != "function") {
		callback = null;
	}
	if (!bodyName || typeof (bodyName) != "string") {
		bodyName = "sensor.request";
	}

	return this._sendXplX(body, bodyName, callback, "xpl-cmnd");
};

XplAPI.prototype.addHeadSchema = function(headName, schema) {
	var headSchemas = this._headSchemas;
	if (!headSchemas) {
		headSchemas = {};
		this._headSchemas = headSchemas;
	}

	headSchemas[headName] = schema;
};

XplAPI.prototype.addBodySchema = function(bodyName, schema) {
	var bodySchemas = this._bodySchemas;
	if (!bodySchemas) {
		bodySchemas = {};
		this._bodySchemas = bodySchemas;
	}

	bodySchemas[bodyName] = schema;
};

XplAPI.prototype._validSchema = function(schema, obj) {

	for ( var fieldName in obj) {
		var desc = schema.properties[fieldName];
		if (!desc) {
			var e = new Error("Unknown field '" + fieldName + "'");
			e.code = "UNKNOWN_FIELD";
			throw e;
		}

		var value = obj[fieldName];
		if (value === undefined) {
			var e = new Error("Field '" + fieldName + "' has not value");
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
				var e = new Error("Invalid integer field='" + fieldName + "' value=" + value);
				e.code = "NOT_A_NUMBER";
				throw e;
			}
			if (typeof (desc.minimum) === 'number') {
				if (newValue < desc.minimum) {
					var e = new Error("Invalid range of integer field='" + fieldName + "' value=" + value + " minimum=" +
							desc.minimum);
					e.code = "RANGER_ERROR";
					throw e;
				}
			}
			if (typeof (desc.maximum) === 'number') {
				if (newValue > desc.maximum) {
					var e = new Error("Invalid range of integer field='" + fieldName + "' value=" + value + " maximum=" +
							desc.maximum);
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
					var e = new Error("Regexp has not matched field='" + fieldName + "' value=" + value + " regExp=" + pattern);
					e.code = "REGEXP_NOT_MATCHED";
					throw e;
				}
			}

			var _enum = desc.enum;
			if (_enum && _enum.indexOf) {
				if (_enum.indexOf(value) < 0) {
					var e = new Error("String is not in the enum field='" + fieldName + "' value=" + value + " enum=" + _enum);
					e.code = "NOT_IN_ENUM";
					throw e;
				}
			}
			break;

		default:
			var e = new Error("Type is not implemented '" + desc.type + "'");
			e.code = "NOT_IMPLEMENTED";
			throw e;
		}
	}

	if (schema.required) {
		schema.required.forEach(function(name) {
			if (!(name in obj)) {
				var e = new Error("Required field not specified fieldName='" + name + "'");
				e.code = "REQUIRED_FIELD_NOT_SPECIFIED";
				throw e;
			}
		});
	}
};
