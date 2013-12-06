/**
 * New node file
 */

var Xpl=require("./lib/xpl-api");

var xpl=new Xpl({
	source: "nodejs-sample"
});

xpl.on("message", function(event, address) {
	console.log("Receive event ", event, " from ", address);
	
});

xpl.wait(function(error) {
	console.log("Wait return ", error);
});

xpl.sendXplTrig({
	device: "cul",
	type: "temp",
	current: 20.4
});
