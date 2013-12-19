# xpl-api

## Objective

XPL layer for nodejs

## Installation

    $ npm install xpl-api

## Usage

Waiting for XPL messages :
```javascript
var Xpl=require("xpl-api");

var xpl=new Xpl();

xpl.on("message", function(message) {
	console.log("Receive message ", message);
	
});

xpl.on("close", function() {
	console.log("Receive close event");
});

xpl.bind(function(error) {
	console.log("Bind return ", error);
});
```

Sending XPL messages :
```javascript
var Xpl=require("xpl-api");

var xpl=new Xpl({
	source: "nodejs-sample",
	broadcastAddress: "192.168.X.Y" // <<< you must specify a correct IP
});

xpl.sendXplTrig({
	device: "temp1 0x90",
	type: "temp",
	current: 20.4
});

xpl.sendXplCmnd({
	request: "on",
	device: "x10"
});
```
 