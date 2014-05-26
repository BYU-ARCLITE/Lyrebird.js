var MP3Encoder = (function(){
	"use strict";
	
	var workerURL = URL.createObjectURL(
		new Blob(
			['(' + workerFn.toString() + ')();'],
			{type: "text/javascript"}
		)
	);
	
	function dispatchMessages(e){
		var data = e.data;
		switch(data.cmd){
		case 'reset':
			this.buffers = [];
			this.pq.shift().resolve(this);
			break;
		case 'data':
			this.buffers.push(data.mp3data);
			this.pq.shift().resolve(this);
			break;
		case 'end':
			//Why copy buffers ourselves when the Blob constructor will do it for us?
			this.buffers.push(data.mp3data);
			this.pq.shift().resolve(new Blob(this.buffers,{type: 'audio/mp3'}));
			this.buffers = [];
		}
	}
	
	function Encoder(opts){ //channels, mode, samplerate, bitrate
		var worker = new Worker(workerURL),
			that = this;
		
		if(typeof opts !== 'object'){ opts = {}; }
		
		this.worker = worker;
		this.stereo = opts.channels === 1?false:true;
		this.buffers = [];
		this.pq = [];
		this.terminated = false;
		
		worker.addEventListener('message',dispatchMessages.bind(this),false);
		worker.addEventListener('error',function(e){ that.pq.shift().reject(e); },false);
		worker.postMessage({
			cmd: 'import',
			url: Encoder.LAME_URI
		});
		return new Promise(function(resolve, reject){
			that.pq.push({
				resolve: resolve,
				reject: reject
			});
			worker.postMessage({
				cmd: 'init',
				config: {
					mode: opts.mode || 1, //Lame.JOINT_STEREO
					channels: opts.channels === 1?1:2,
					samplerate: +opts.samplerate || 44100,
					bitrate: +opts.bitrate || 128
				}
			});
		});	
	}
	
	Encoder.LAME_URI =	location.protocol + "//" + location.hostname +
						(location.port && ":" + location.port) + "/js/libmp3lame.js";

	function sendMsg(that, msg){
		return new Promise(function(resolve, reject){
			that.worker.postMessage(msg);
			that.pq.push({
				resolve: resolve,
				reject: reject
			});
		});
	}
	
	Encoder.prototype.reset = function(){
		return sendMsg(this, {cmd: 'reset'});
	};
	
	Encoder.prototype.encode = function(channels){
		return sendMsg(this, {
			cmd: 'encode',
			channels: channels.slice(0,this.stereo?2:1)
		});
	};
	
	Encoder.prototype.end = function(){
		return sendMsg(this, {cmd: 'end'});
	};
	
	Encoder.prototype.destroy = function(){
		this.worker.terminate();
		this.pq.forEach(function(p){ p.reject(new Error('encoder terminated')); });
		this.terminated = true;
	};

	function workerFn(){
		"use strict";
		var codec, encode, config;
		
		function monoEncode(codec,chan){
			return Lame.encode_buffer_ieee_float(codec, chan[0], chan[0]).data.buffer;
		}

		function stereoEncode(codec,chan){
			return Lame.encode_buffer_ieee_float(codec, chan[0], chan[1]).data.buffer;
		}
		
		function newEncoder(config){
			var mp3codec = Lame.init();
			Lame.set_mode(mp3codec, config.mode);
			Lame.set_num_channels(mp3codec, config.channels);
			Lame.set_out_samplerate(mp3codec, config.samplerate);
			Lame.set_bitrate(mp3codec, config.bitrate);
			Lame.init_params(mp3codec);
			return mp3codec;
		}

		self.onmessage = function(e){
			var data = e.data,
				mp3data;
			switch(data.cmd){
			case 'import':
				importScripts(data.url);
				break;
			case 'init':
				config = data.config;
				encode = config.channels === 1?monoEncode:stereoEncode;
			case 'reset':
				codec = newEncoder(config);
				self.postMessage({cmd: 'reset'});
				break;
			case 'encode':
				mp3data = encode(codec, data.channels);
				self.postMessage({cmd: 'data', mp3data: mp3data},[mp3data]);
				break;
			case 'end':
				mp3data = Lame.encode_flush(codec).data.buffer;
				self.postMessage({cmd: 'end', mp3data: mp3data},[mp3data]);
				Lame.close(codec);
				codec = newEncoder(config);
				break;
			}
		};
	}

	return Encoder;
}());