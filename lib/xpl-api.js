var Dgram = require('dgram');
var Underscore = require('underscore');
var Events = require('events');
var Process = require('process');

var APIv1 = module.exports = function(configuration) {
	this.configuration = Underscore.clone(configuration || {});
	this.configuration.port = this.configuration.port || 3865;
	if (this.configuration.hubMode === undefined) {
		this.configuration.hubMode = true;
	}
	this.configuration.socketType = this.configuration.socketType || 'udp4';
	this.configuration.broadcastAddress = null;
	this.configuration.localAddress = this.configuration.hubAddress || "127.0.0.1";
	// this.configuration.ttl = 0;
	this.configuration.hubPingDelayMs = this.configuration.hubPingDelayMs || 1000 * 60 * 4;
	this.configuration.source = this.configuration.source || "nodejs-xpl."+ Process.pid;
};

APIv1.prototype._startHub = function(callback) {

	var self = this;
	this._connect(this.configuration.broadcastAddress, this.configuration.port,
			false, function(error, emitter, address, socket) {

				console.log("Try to start a hub =>", error, emitter, address,
						socket);
				if (error) {
					return callback(error);
				}

				self._inputEmitter = emitter;
				self._inputSocket = socket;
				self._inputBroadcast = false;

				self._hubClients = {};

				emitter.on("messsage", function(message, address) {
					console.log("Hub receive message from=", address,
							" message=", message);

					// XPL Message

					// An heart beat ? Register it

					if (message.bodyName == "hbeat.app") {
						var key=address.address+":"+address.port;
						var now=Date.now();
						var clients = this._hubClients;
						clients[key]={
							ttl: now+this.configuration.hubPingDelayMs,
							address: address.address,
							port: address.port
						};
						
						return;
					}

					self._broadcastMessage(message);
				});
			});
};

APIv1.prototype._broadcastMessage = function(message) {
	var now = Date.now();
	var clients = this._hubClients;

	function sendMessage(error) {
		if (error) {
			console.log("Can not broadcast message. error=", error);
			return;
		}

		console.log("Forward broadcasted message to ");
	}

	var socket = this._getOutputSocket();

	for ( var clientName in clients) {
		var client = clients[clientName];

		if (client.ttl > now) {
			delete clients[clientName];
			continue;
		}

		socket.send(buffer, 0, buffer.length, client.port, client.address,
				sendMessage);
	}
};

APIv1.prototype._connectHub = function(callback) {
	console.log("Try to connect to the hub ...");

	var self = this;
	this._connect(this.configuration.localAddress, 0, false, function(err,
			emitter, socket) {
		if (err) {
			return callback(err, emitter);
		}

		self._hubSocket = socket;
		self._hubEmitter = emitter;

		self._hubInterval = setInterval(function() {
			self._hubPing(emitter, socket);

		}, self.configuration.hubPingDelayMs);

		return callback(null, emitter, socket);
	});

};

APIv1.prototype._hubPing = function(emitter, socket) {
	var interval=Math.floor(this.configuration.hubPingDelayMs/1000/60);
	if (interval<1) {
		interval=1;
	}
	
	var message = {
		headerName : "xpl-stat",
		header : {
			hop : 1,
			source : this.configuration.source,
			target : this.configuration.target
		},
		bodyName : "hbeat.app",
		body : {
			interval : interval,
			port : socket.address().port,
			"remote-ip" : this.configuration.localAddress
		}
	};

	var buffer = this._xplMessageToBuffer(message);

	socket.send(buffer, 0, buffer.length, this.configuration.port,
			this.configuration.localAddress, function(error, bytes) {
				console.log("Send heart beat ", error);
			});

};

APIv1.prototype.wait = function(callback) {
	this.close();

	var self = this;
	this._startHub(function(error) {
		if (error) {
			// A HUB is already present !

			return self._connectHub(callback);
		}

		// Hub created
		callback(null);
	});
};

APIv1.prototype._connect = function(address, port, broadcastType, callback) {

	var config = this.configuration;

	var emitter = new Events.EventEmitter();
	var closeState = false;

	var self = this;
	var socket = Dgram.createSocket(config.socketType, function(event, buffer,
			param1, param2) {
		console.log("Hub socket receives event ", event, " from ", param2);

		if (closeState) {
			return;
		}

		switch (event) {
		case "close":
			closeState = true;
			break;

		case "error":
		case "listening":
			emitter.emit(event, param1);
			break;

		case "message":
			var packet = self._parseXPLMessage(param1);
			if (packet) {
				emitter.emit("message", packet, param2);

				if (packet.headerName) {
					emitter.emit("xpl:" + packet.headerName, packet, param2);
				}
				if (packet.bodyName) {
					emitter.emit("xpl:" + packet.bodyName, packet, param2);
				}
			}
			break;
		}
	});

	socket.on("error", function(err) {
		console.log("server error:\n" + err.stack);
	});

	if (config.ttl) {
		socket.setTTL(config.ttl);
		console.log("Socket: set TTL to " + config.ttl);
	}
	if (broadcastType) {
		socket.setBroadcast(true);
		console.log("Socket: set broadcast type");
	}

	socket.bind(port, address, function(err, param1) {
		if (closeState) {
			return callback("error", new Error("Socket closed"));
		}

		if (err) {
			console.log("Socket bind failed '", err, "' param=", param1);

			return callback(event, param1);
		}

		var address = socket.address();

		console.log("Bind success on ", address);

		return callback(null, emitter, address, socket);
	});
};

APIv1.prototype.sendMessage = function(headerName, header, bodyName, body,
		callback) {
	var message = {
		headerName : hearderName,
		header : header,
		bodyName : bodyName,
		body : body
	};

	return this.sendXplMessage(message, callback);
};

APIv1.prototype._xplMessageToBuffer = function(xplMessage) {

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

APIv1.prototype.sendXplMessage = function(xplMessage, callback) {
	if (!xplMessage.headerName) {
		return callback(new Error("Invalid XPL message format ", xplMessage));
	}

	var buffer=this._xplMessageToBuffer(xplMessage);
	
	return this.sendBufferMessage(buffer, callback);
};

APIv1.prototype.sendBufferMessage = function(buffer, callback) {

	this._getBroadcastOutputSocket(function(err, socket) {
		if (error) {
			return callback(error);
		}

		socket.send(buffer, 0, buffer.length, this.configuration.port,
				this.configuration.broadcastAddress, function(error, bytes) {
					if (error) {
						return callback(err);
					}

					return callback(null, socket);
				});
	});
};

APIv1.prototype._getOutputSocket = function(callback) {

	if (this._outputSocket) {
		return this._outputSocket;
	}

	if (this._inputSocket && !this._inputBroadcast) {
		// We can use input socket to send message
		return callback(null, this._inputSocket);
	}

	var self = this;
	this._connect(this.configuration.localAddress, 0, false, function(error,
			emitter, socket) {
		if (!error) {
			self._outputSocket = socket;
		}
		return callback(error, socket);
	});
};

APIv1.prototype._getBroadcastOutputSocket = function(callback) {

	if (this._outputBroadcastSocket) {
		return this._outputBroadcastSocket;
	}

	if (this._inputSocket && this._inputBroadcast) {
		// We can use input socket to send message
		return callback(null, this._inputSocket);
	}

	var self = this;
	this._connect(this.configuration.broadcastAddress, this.configuration.port,
			false, function(error, emitter, socket) {
				if (error) {
					return callback(error);
				}

				self._outputBroadcastSocket = socket;
				return callback(error, socket);
			});
};

APIv1.prototype.close = function(callback) {
	if (this._inputSocket) {
		if (this._inputInterval) {
			clearInterval(this._inputInterval);
			this._inputInterval = undefined;
		}
		this._inputEmitter.emit("close");
		this._inputEmitter = undefined;
		this._inputSocket.close();
		this._inputSocket = undefined;
	}
	if (this._outputSocket) {
		this._outputSocket.close();
		this._outputSocket = undefined;
	}
	if (this._outputBroadcastSocket) {
		this._outputBroadcastSocket.close();
		this._outputBroadcastSocket = undefined;
	}

	this._hubClients = undefined;

	return callback;
};

APIv1.prototype._parseXPLMessage = function(buffer) {
	var lines = buffer.replace(/\r/gm, "").split("\n");

	var dest = {};
	this._parseXPLBlock(dest, "headerName", "header", lines);
	this._parseXPLBlock(dest, "bodyName", "body", lines);

	return dest;
};

APIv1.prototype._parseXPLBlock = function(dest, blockName, blockVar, buffer) {
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
