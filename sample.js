/**
 * New node file
 */

var Xpl=require("./lib/xpl-api");

var xpl=new Xpl();

xpl.on("message", function(event, address) {
	console.log("Receive event ", event, " from ", address);
	
});

xpl.wait(function(error) {
	console.log("Wait return ", error);
});