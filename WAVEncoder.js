var WAVEncoder = (function(){
	"use strict";

	/*
	http://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html
	*/

	var workerURL = URL.createObjectURL(
		new Blob(
			['(' + workerFn.toString() + ')();'],
			{type: "text/javascript"}
		)
	);

	function dispatchMessages(e){
		var data = e.data;
		switch(data.cmd){
		case 'data':
			if(!this.stream){ this.buffers.push(data.wavdata); }
			this.pq.shift().resolve(data.wavdata);
			break;
		case 'end':
			if(this.stream){
				this.pq.shift().resolve([data.wavdata]);
			}else{
				this.buffers.push(data.wavdata);
				this.pq.shift().resolve([
					data.wavdata,
					exportWAV(this.encoder, this.buffers)
				]);
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
			channels: encoder.channels,
			byterate: encoder.bitrate/8
		});

		this.encoder = encoder;
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

	function WAVEncoder(opts){ //channels, samplerate, bitrate, stream
		if(typeof opts !== 'object'){ opts = {}; }
		var bitrate = +opts.bitrate || 32;

		if(bitrate % 8 !== 0 || bitrate > 64){
			throw new Error("Invalid bitrate.");
		}

		this.stream = !!opts.stream;
		this.bitrate = bitrate;
		this.samplerate = +opts.samplerate || 44100;
		this.channels = opts.channels === 1?1:2;
		this.worker = new EncoderWorker(this);
	}

	WAVEncoder.prototype.reset = function(hard){
		if(hard){ this.worker.terminate(); }
		this.worker = new EncoderWorker(this);
	};

	WAVEncoder.prototype.encode = function(inputs){
		return this.worker.msg({
			cmd: 'encode',
			inputs: inputs.slice(0,this.channels)
		});
	};

	WAVEncoder.prototype.end = function(){
		return this.worker.msg({cmd: 'end'});
	};

	function writeString(view, offset, string){
		for (var i = 0; i < string.length; i++){
			view.setUint8(offset + i, string.charCodeAt(i));
		}
	}

	function exportWAV(encoder, buffers){
		var buffer = new ArrayBuffer(44),
			view = new DataView(buffer),
			blockalign = encoder.channels * (encoder.bitrate / 8),
			datasize;

		datasize = buffers.reduce(function(acc,next){
			return acc + next.byteLength;
		},0);

		/* RIFF identifier */
		writeString(view, 0, 'RIFF');
		/* file length */
		view.setUint32(4, 32 + datasize, true);
		/* RIFF type & format chunk identifier*/
		writeString(view, 8, 'WAVEfmt ');
		/* format chunk length */
		view.setUint32(16, 16, true);

		/* sample format (int PCM or IEEE Float) */
		view.setUint16(20, encoder.bitrate < 32?1:3, true);

		/* channel count & sample rate*/
		view.setUint16(22, encoder.channels, true);
		view.setUint32(24, encoder.samplerate, true);

		/* byte rate, alignment, & bit depth */
		view.setUint32(28, encoder.samplerate * blockalign, true);
		view.setUint16(32, blockalign, true);
		view.setUint16(34, encoder.bitrate, true);

		/* data chunk identifier */
		writeString(view, 36, 'data');
		/* data chunk length */
		view.setUint32(40, datasize, true);

		return new Blob([view.buffer].concat(buffers), { type: 'audio/wave' });
	}

	function workerFn(){
		"use strict";
		var encoder;

		var w_methods = {
			2: 'setInt16',
			4: 'setFloat32',
			8: 'setFloat64'
		};

		self.onmessage = function(e){
			var byterate, wavdata,
				data = e.data;
			switch(data.cmd){
			case 'init':
				byterate = data.byterate;
				encoder = new (byterate === 1?Encoder8Bit:EncoderNorm)(
					data.channels, byterate
				);
				break;
			case 'encode':
				wavdata = encoder.encode(data.inputs);
				self.postMessage({cmd: 'data', wavdata: wavdata},[wavdata]);
				break;
			case 'end':
				//This might actually server a purpose
				//if I implement output size normalization
				wavdata = new ArrayBuffer(0);
				self.postMessage({cmd: 'end', wavdata: wavdata},[wavdata]);
				break;
		  }
		};

		function Encoder8Bit(channels){
			this.channels = channels;
		}

		function byte_interlace(inputs, channels){
			var i, o, c, cbuf, len, output;
			len = Math.min.apply(Math,inputs.map(function(a){
				return a.length;
			})) * channels;

			if(!isFinite(len)){ len = 0; }
			output = new Uint8Array(len);

			for(c = 0; c < channels; ++c){
				cbuf = inputs[c];
				for(i = 0, o = c; i < len; ++i, o += channels){
					output[o] = cbuf[i];
				}
			}

			return output.buffer;
		}

		Encoder8Bit.prototype.encode = function(inputs){
			var uint_inputs = inputs.map(function(buffer){
				var i; //convert to offset binary
				buffer = new Uint8Array(buffer.buffer);
				for(i = buffer.length-1; i >= 0; --i){ buffer[i] ^= 0x80; }
				return buffer;
			});
			return byte_interlace(uint_inputs, this.channels);
		}

		function EncoderNorm(channels, byterate){
			this.channels = channels;
			this.byterate = byterate;
			this.w_method = w_methods[byterate];
		}

		EncoderNorm.prototype.encode = interlace_little_endian;

		function interlace_little_endian(inputs){
			var i, o, c, len, cbuf,
				output, view, write, stride,
				channels = this.channels,
				byterate = this.byterate;

			stride = byterate * channels;
			len = Math.min.apply(Math,inputs.map(function(a){
				return a.length;
			})) * stride;

			if(!isFinite(len)){ len = 0; }
			output = new ArrayBuffer(len);
			view = new DataView(output);
			write = view[this.w_method].bind(view);

			for(c = 0; c < channels; ++c){
				cbuf = inputs[c];
				for(i = 0, o = c*byterate; o < len; ++i, o += stride){
					write(o, cbuf[i], true);
				}
			}

			return output;
		}
	}

	return WAVEncoder;
}());