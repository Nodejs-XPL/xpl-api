/**
 * New node file
 */

var Xpl=require("./lib/xpl-api");

var xpl=new Xpl();

xpl.wait(function(event) {
	console.log("Receive event ", event);
});