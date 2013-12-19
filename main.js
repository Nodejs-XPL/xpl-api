/**
 * New node file
 */

var Xpl=require("./lib/xpl-api");

var xpl=new Xpl({
	source: "nodejs-sample",
	xplLog: false,
	broadcastAddress: "192.168.1.255"
});

xpl.on("message", function(message) {
	console.log("Receive message ", message);
	
});

xpl.on("close", function() {
	console.log("Receive close even");
});

xpl.bind(function(error) {
	console.log("Bind return ", error);
});

xpl.sendXplTrig({
	device: "cul",
	type: "temp",
	current: 20.4
});
