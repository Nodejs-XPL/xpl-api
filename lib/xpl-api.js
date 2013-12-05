var Dgram = require('dgram');
var Underscore = require('underscore');
var Events = require('events');

var APIv1 = module.exports = function(configuration) {
	this.configuration = Underscore.clone(configuration || {});
	this.configuration.port = this.configuration.port || 3865;
	if (this.configuration.hubMode===undefined) {
		this.configuration.hubMode = true;
	}
	this.configuration.socketType = this.configuration.socketType || 'udp4';
	this.configuration.broadcastAddress = null;
	this.configuration.hubAddress = this.configuration.hubAddress || "127.0.0.1";
	//this.configuration.ttl = 0;
	this.configuration.hubPingDelayMs=this.configuration.hubPingDelayMs || 1000*60*4;
};

APIv1.prototype.connectHub = function(callback) {
	if (this._hubSocket) {
		return callback(this._hubEmitter);
	}

	var self = this;
	this._connect(this.configuration.hubAddress, false, function(err, emitter,
			socket) {
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
	
};

APIv1.prototype.wait = function(callback) {
	return this._connect(null, true, callback);
};

APIv1.prototype._connect = function(address, broadcastType, callback) {

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

	socket.on("error", function (err) {
		console.log("server error:\n" + err.stack);
	});
	
	if (config.ttl) {
		socket.setTTL(config.ttl);
		console.log("Socket: set TTL to "+config.ttl);
	}
	if (broadcastType) {
		//socket.setBroadcast(true);
		console.log("Socket: set broadcast type");
	}

	socket.bind(41000, address, function(err, param1) {
		console.log("Socket bind receives err=", err, " param1=",param1);

		if (closeState) {
			return callback("error", new Error("Socket closed"));
		}

		if (err) {
			return callback(event, param1);
		}

		return callback(null, emitter, socket);
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

APIv1.prototype.sendXplMessage = function(xplMessage, callback) {
	if (!xplMessage.headerName) {
		return callback(new Error("Invalid XPL message format ", xplMessage));
	}

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

	return this.sendBufferMessage(new Buffer(message), callback);
};

APIv1.prototype.sendBufferMessage = function(buffer, callback) {
	var self = this;

	if (!this._outputSocket) {
		this._openOutputSocket(function(ret) {
			if (ret) {
				return callback(ret);
			}

			return self.sendMessage(message, callback);
		});
	}

	var socket = this._outputSocket;
	socket.send(buffer, 0, buffer.length, this.configuration.port,
			this.configuration.broadcastAddress, function(err, bytes) {
				return callback(err);
			});
};

APIv1.prototype.close = function(callback) {
	if (this._hubSocket) {
		if (this._hubInterval) {
			clearInterval(this._hubInterval);
			this._hubInterval=undefined;
		}
		this._hubEmitter.emit("close");
		this._hubEmitter = undefined;
		this._hubSocket.close();
		this._hubSocket = undefined;
	}
	if (this._outputSocket) {
		this._outputSocket.close();
		this._outputSocket = undefined;
	}

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
