var AudioRecorder = (function(){

	var arrayTypes = {
		8: Int8Array,
		16: Int16Array,
		32: Float32Array,
		64: Float64Array
	};

	function Int8toInt16(source){
		var i, len = source.length,
			dest = new Int16Array(len);
		for(i = 0; i < len; i++){ dest[i] = source[i] << 8; }
		return dest;
	}

	function Int16toInt8(source){
		var i, len = source.length,
			dest = new Int8Array(len);
		for(i = 0; i < len; i++){ dest[i] = source[i] >> 8; }
		return dest;
	}

	function IntToFloat(dtype,max){
		return function(source){
			var i, len = source.length,
				dest = new dtype(len);
			for(i = 0; i < len; i++){ dest[i] = source[i] / max; }
			return dest;
		};
	}

	function FloatToInt(dtype,max){
		return function(source){
			var i, len = source.length,
				dest = new dtype(len);
			for(i = 0; i < len; i++){ dest[i] = Math.round(source[i] * max); }
			return dest;
		};
	}

	function calcDepthConversion(from,to){
		if(from === to){ return function(a){ return a; }; }
		switch(from){
		case 8:
			if(to === 16){ return Int8toInt16; }
			return IntToFloat(to === 32?Float32Array:Float64Array, 128);
		case 16:
			if(to === 8){ return Int16toInt8; }
			return IntToFloat(to === 32?Float32Array:Float64Array, 32768);
		case 32:
			if(to === 8){ return FloatToInt(Int8Array, 128); }
			if(to === 16){ return FloatToInt(Int16Array, 32768); }
			return function(source){ return new Float64Array(source); };
		case 64:
			if(to === 8){ return FloatToInt(Int8Array, 128); }
			if(to === 16){ return FloatToInt(Int16Array, 32768); }
			return function(source){ return new Float32Array(source); };
		}
	}

	function Recorder(sp,ep){
		var that = this;

		this.events = {};
		this.recording = false;
		this.source = null;
		this.encoder = null;
		this.resampler = null;
		this.queued = 1;
		this.finished = 0;

		function enc_suc(data){
			that.finished++;
			that.emit('data',data);
		}

		function enc_err(err){
			that.emit('error',err);
		}

		return Promise.all([sp, ep]).then(function(arr){
			var dconv, resampler,
				source = arr[0],
				encoder = arr[1];

			if(source.channels !== encoder.channels){
				throw new Error("Channel Mismatch.");
			}
			if(!arrayTypes.hasOwnProperty(source.bitrate)){
				throw new Error("Invalid Source Bitrate.");
			}
			if(!arrayTypes.hasOwnProperty(encoder.bitrate)){
				throw new Error("Invalid Encoder Bitrate.");
			}

			dconv = calcDepthConversion(source.bitrate,encoder.bitrate);

			//resample at the lower bitrate to save memory
			if(source.bitrate < encoder.bitrate){
				resampler = new Resampler({
					channels: source.channels,
					bitrate: encoder.bitrate,
					from: source.samplerate,
					to: encoder.samplerate,
					bufferSize: encoder.bufferSize
				});
				resampler.on('data',function(inputs){
					that.queued++;
					encoder.encode(inputs)
					.then(enc_suc,enc_err);
				});
				source.pipe(function(inputs){
					if(!that.recording){ return; }
					//convert to encoder bitrate before resampling
					resampler.append(inputs.map(dconv));
				});
			}else{
				resampler = new Resampler({
					channels: source.channels,
					bitrate: source.bitrate,
					from: source.samplerate,
					to: encoder.samplerate,
					bufferSize: encoder.bufferSize
				});
				resampler.on('data',function(inputs){
					that.queued++;
					//convert to encoder bitrate after resampling
					encoder.encode(inputs.map(dconv))
					.then(enc_suc,enc_err);
				});
				source.pipe(function(inputs){
					if(!that.recording){ return; }
					resampler.append(inputs);
				});
			}

			that.source = source;
			that.encoder = encoder;
			that.resampler = resampler;
			return that;
		});
	}

	Recorder.prototype.on = function(ename, handler){
		if(!this.events.hasOwnProperty(ename)){
			this.events[ename] = [handler];
		}else{
			this.events[ename].push(handler);
		}
	};

	Recorder.prototype.off = function(ename, handler){
		var i, evlist = this.events[ename];
		if(!evlist){ return; }
		i = evlist.indexOf(handler);
		if(~i){ evlist.splice(i,1); }
	};

	Recorder.prototype.emit = function(ename, obj){
		var evlist = this.events[ename];
		if(!evlist){ return; }
		evlist.forEach(function(h){ h.call(this, obj); }, this);
	};

	Recorder.prototype.record = function(){
		this.recording = true;
	};

	Recorder.prototype.pause = function(){
		this.recording = false;
	};

	Recorder.prototype.reset = function(hard){
		this.recording = false;
		this.queued = 1;
		this.finished = 0;
		this.resampler.reset(true);
		this.encoder.reset(hard);
	};

	Recorder.prototype.finish = function(){
		//TODO: Make sure resmapler is flushed
		var that = this,
			endp = this.encoder.end();
		endp.then(function(arr){
			var frame = arr[0],
				blob = arr[1];
			that.finished++;
			that.emit('data', arr[0]);
			that.emit('end', arr[1]);
		});
		return endp.then(function(arr){ return arr[1]; });
	};

	return Recorder;

}());