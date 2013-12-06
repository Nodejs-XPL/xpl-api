# xpl-api

## Objective

XPL layer for nodejs

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
var Xpl=require("./lib/xpl-api");

var xpl=new Xpl({
	source: "nodejs-sample"
});

xpl.sendXplTrig({
	device: "temp1 0x90",
	type: "temp",
	current: 20.4
});
```
 