/**
 * New node file
 */

var Xpl = require("./lib/xpl-api");
var commander = require('commander');

Xpl.fillCommander(commander);

commander.parse(process.argv);

var xpl = new Xpl(commander);

xpl.on("message", function(message) {
//	console.log("Receive message ", message);

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
