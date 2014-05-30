var MP3Encoder = (function(){
	"use strict";

	var workerURL = URL.createObjectURL(
		new Blob(
			['(' + workerFn.toString() + ')();'],
			{type: "text/javascript"}
		)
	);

	var sampleRates = [ 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000 ];

	function dispatchMessages(e){
		var data = e.data;
		switch(data.cmd){
		case 'data':
			if(!this.stream){ this.buffers.push(data.mp3data); }
			this.pq.shift().resolve(this);
			break;
		case 'end':
			if(this.stream){
				this.pq.shift().resolve([data.mp3data]);
			}else{
				//Why copy buffers ourselves when the Blob constructor will do it for us?
				this.buffers.push(data.mp3data);
				this.pq.shift().resolve([data.mp3data, new Blob(this.buffers,{type: 'audio/mp3'})]);
			}
			this.buffers = [];
		}
	}

	function EncoderWorker(encoder){
		var that = this,
			worker = new Worker(workerURL);
		worker.addEventListener('message',dispatchMessages.bind(this),false);
		worker.addEventListener('error',function(e){
			try{ that.pq.shift().reject(e); }
			catch(_){}
		},false);
		worker.postMessage({
			cmd: 'init',
			url: MP3Encoder.LAME_URI,
			channels: encoder.channels,
			samplerate: encoder.samplerate,
			bitrate: encoder.bitrate
		});

		this.worker = worker;
		this.stream = encoder.stream;
		this.buffers = [];
		this.pq = [];
	}

	EncoderWorker.prototype.msg = function(msg){
		var that = this;
		return new Promise(function(resolve, reject){
			that.worker.postMessage(msg);
			that.pq.push({
				resolve: resolve,
				reject: reject
			});
		});
	};

	EncoderWorker.prototype.terminate = function(){
		this.pq.forEach(function(p){ p.reject(new Error('Worker Terminated.')); });
		this.worker.terminate();
	};

	function nearestSampleRate(rate){
		rate = +rate; //make sure it's a number
		if(!rate){ return 44100; }
		if(~sampleRates.indexOf(rate)){ return rate; }
		sampleRates.sort(function(a,b){
			return Math.abs(a-rate) < Math.abs(b-rate) ? -1 : 1;
		});
		return sampleRates[0];
	}

	function MP3Encoder(opts){ //channels, samplerate, bitrate, stream
		if(typeof opts !== 'object'){ opts = {}; }
		this.stream = !!opts.stream;
		this.bitrate = 32;
		this.samplerate = nearestSampleRate(opts.samplerate);
		this.channels = opts.channels === 1?1:2;
		this.worker = new EncoderWorker(this);
	}

	MP3Encoder.LAME_URI =	location.protocol + "//" + location.hostname +
						(location.port && ":" + location.port) + "/js/libmp3lame.js";

	MP3Encoder.prototype.reset = function(hard){
		if(hard){ this.worker.terminate(); }
		this.worker = new EncoderWorker(this);
	};

	MP3Encoder.prototype.encode = function(channels){
		return this.worker.msg({
			cmd: 'encode',
			channels: channels.slice(0,this.channels)
		});
	};

	MP3Encoder.prototype.end = function(){
		return this.worker.msg({cmd: 'end'});
	};

	function workerFn(){
		"use strict";
		var codec, encode, channels,
			samplerate, bitrate;

		function monoEncode(mp3codec,chans){
			return Lame.encode_buffer_ieee_float(mp3codec, chans[0], chans[0]).data.buffer;
		}

		function stereoEncode(mp3codec,chans){
			return Lame.encode_buffer_ieee_float(mp3codec, chans[0], chans[1]).data.buffer;
		}

		function newEncoder(){
			var mp3codec = Lame.init();
			Lame.set_mode(mp3codec, channels === 1?Lame.MONO:Lame.JOINT_STEREO);
			Lame.set_num_channels(mp3codec, channels);
			Lame.set_in_samplerate(mp3codec, samplerate);
			Lame.set_out_samplerate(mp3codec, samplerate);
			Lame.set_bitrate(mp3codec, bitrate);
			Lame.init_params(mp3codec);
			return mp3codec;
		}

		self.addEventListener('message',function(e){
			var data = e.data,
				mp3data;
			switch(data.cmd){
			case 'init':
				importScripts(data.url);
				channels = data.channels;
				samplerate = data.samplerate;
				bitrate = data.bitrate;
				encode = channels === 1?monoEncode:stereoEncode;
				codec = newEncoder();
				break;
			case 'encode':
				mp3data = encode(codec, data.channels);
				self.postMessage({cmd: 'data', mp3data: mp3data},[mp3data]);
				break;
			case 'end':
				mp3data = Lame.encode_flush(codec).data.buffer;
				self.postMessage({cmd: 'end', mp3data: mp3data},[mp3data]);
				Lame.close(codec);
				codec = newEncoder();
				break;
			}
		},false);
	}

	return MP3Encoder;
}());