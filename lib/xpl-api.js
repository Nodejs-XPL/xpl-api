var Dgram = require('dgram');
var Underscore = require('underscore');
var Events = require('events');
var Process = require('process');
var Util = require('util');
var Os = require('os');

var APIv1 = function(configuration) {
	Events.EventEmitter.call(this);

	this.configuration = Underscore.clone(configuration || {});
	this.configuration.port = this.configuration.port || 3865;
	this.configuration.hubMode = this.configuration.hubMode || false;
	this.configuration.socketType = this.configuration.socketType || 'udp4';
	this.configuration.broadcastAddress = null;
	// this.configuration.ttl = 0;
	this.configuration.hubPingDelayMs = this.configuration.hubPingDelayMs || 1000 * 60 * 4;
	this.configuration.source = this.configuration.source || "nodejs-xpl."
			+ Process.pid;
	this.configuration.target = this.configuration.target || "*";
	
	if (!this.configuration.localAddress) {
		var nis=Os.networkInterfaces();
		
		var family=(this.configuration.socketType=="udp6")?"IPv6":"IPv4";
		
		for(var name in nis) {
			var addrs=nis[name];
			
			for(var i=0;i<addrs.length;i++) {
				var addr=addrs[i];
				
				if (addr.internal || addr.family!=family) {
					continue;
				}
				
				this.configuration.localAddress=addr.address;
				
				break;
			}
			
			if (this.configuration.localAddress) {
				break;
			}
		}
		
		
		if (!this.configuration.localAddress) {
			this.configuration.localAddress=(this.configuration.socketType=="udp6")?"::1":"127.0.0.1";
		}
		
		if (!this.configuration.broadcastAddress) {
			var ba=this.configuration.localAddress;
			var idx=ba.lastIndexOf(".");
			if (idx>0) {
				ba=ba.substring(0, idx)+".255";
			}
				
			this.configuration.broadcastAddress=ba;
		}
		
		console.log("localAddress="+this.configuration.localAddress, " broadcastAddress=", this.configuration.broadcastAddress, "nis=",nis);
	}
	
};
Util.inherits(APIv1, Events.EventEmitter);
module.exports = APIv1;
	
APIv1.prototype._startHub = function(callback) {
	console.log("startHub: try to get port");
	var self = this;
	this._connect("", this.configuration.port,
			false, function(error, address, socket) {

				if (error) {
					console.log("startHub: Hub is not started ", error);

					return callback(error);
				}

				console.log("startHub: Hub started ", address,
						socket);

				self._inputSocket = socket;
				self._inputBroadcast = false;

				if (self.configuration.hubMode) {
					self._hubClients = {};
	
					self.on("messsage", function(message, address) {
						console.log("Hub receive message from=", address,
								" message=", message);
	
						// XPL Message
	
						// An heart beat ? Register it
	
						if (message.bodyName == "hbeat.app") {
							var key = address.address + ":" + address.port;
							var now = Date.now();
							var clients = this._hubClients;
							clients[key] = {
								ttl : now + this.configuration.hubPingDelayMs,
								address : address.address,
								port : address.port
							};
	
							return;
						}
	
						self._broadcastMessage(message);
					});
				}
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
	this._connect(this.configuration.localAddress, 0, false, function(err, address, socket) {
		if (err) {
			return callback(err);
		}

		console.log("Connecting to the hub ...");

		self._inputSocket = socket;
		self._inputBroadcast = false;

		self._hubInterval = setInterval(function() {
			self._hubPing(address, socket);

		}, self.configuration.hubPingDelayMs);
		self._hubPing(address, socket);

		return callback(null, address);
	});

};

APIv1.prototype._hubPing = function(address, socket) {
	console.log("hubPing: send heart beat !");
	var interval = Math.floor(this.configuration.hubPingDelayMs / 1000 / 60);
	if (interval < 1) {
		interval = 1;
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
			port : address.port,
			"remote-ip" : address.address || this.configuration.localAddress
		}
	};

	var buffer = this._xplMessageToBuffer(message);

	console.log("hubPing: buffer=", buffer.toString(), " port=", this.configuration.port,
			" address=", this.configuration.broadcastAddress);

	socket.send(buffer, 0, buffer.length, this.configuration.port,
			this.configuration.broadcastAddress, function(error, bytes) {
				console.log("Send heart beat error=", error);
			});

};

APIv1.prototype.wait = function(callback) {
	this.close();

	var self = this;
	this._startHub(function(error) {
		if (error) {
			console.log("Start Hub return error (a HUB is already started ?",
					error);
			// A HUB is already present !

			return self._connectHub(callback);
		}

		console.log("Start Hub success");

		// Hub created
		callback(null);
	});
};

APIv1.prototype._connect = function(address, port, broadcastType, callback) {

	var config = this.configuration;

	var closeState = false;

	console.log("_connect: address=", address, " port=", port,
			" broadcastType=", broadcastType);

	var self = this;
	var socket = Dgram.createSocket(config.socketType);

	var listening = false;

	socket.on("close", function() {
		closeState = true;
	});
	
	socket.on("message", function(buffer, address) {
		var message=buffer.toString();
		
		var packet = self._parseXPLMessage(message);

		console.log("Receive packet=",packet," from=",address);
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
		console.log("_connect: socket error", error, error.stack);
		socket.close();

		if (!listening) {
			return callback(error, null);
		}
		
		self.emit("error", error);
	});
	socket.on("listening", function() {
		listening = true;

		var address = socket.address();
		console.log("_connect: socket listening " + address.address + ":"
				+ address.port);
	});

	if (config.ttl) {
		socket.setTTL(config.ttl);
		console.log("Socket: set TTL to " + config.ttl);
	}
	if (broadcastType) {
		socket.setBroadcast(true);
		console.log("Socket: set broadcast type");
	}

	console.log("_connect: bind address=", address, " port=", port);

	socket.bind(port, address, function(error, param1) {
		if (closeState) {
			return callback("error", new Error("Socket closed"));
		}

		if (error) {
			console.log("Socket bind failed '", err, "' param=", param1);

			return callback(event, param1);
		}

		var address = socket.address();

		console.log("Bind success on ", address);

		return callback(null, address, socket);
	});

	console.log("_connect: END");
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

	var buffer = this._xplMessageToBuffer(xplMessage);

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
	this._connect(this.configuration.localAddress, 0, false, function(error, socket) {
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
			false, function(error, socket) {
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
		this.emit("close");
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

APIv1.prototype._parseXPLBlock = function(dest, blockName, blockVar, lines) {
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
