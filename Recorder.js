var AudioRecorder = (function(){

	var arrayTypes = {
		8: Int8Array,
		16: Int16Array,
		32: Float32Array,
		64: Float64Array
	};

	function Recorder(sp,ep){
		var that = this;

		this.events = {};
		this.recording = false;
		this.source = null;
		this.encoder = null;
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
			var btcv, resampler,
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

			btcv = (source.bitrate === encoder.bitrate)?
				function(buf){ return buf; }:
				(function(cons){
					return function(buf){ return new cons(buf); };
				}(arrayTypes[encoder.bitrate]));

			if(source.samplerate === encoder.samplerate){
				//No resampling required
				source.pipe(function(inputs){
					if(!that.recording){ return; }
					that.queued++;
					encoder.encode(inputs.map(btcv))
					.then(enc_suc,enc_err);
				});
			}else{
				resampler = new Resampler({
					channels: source.channels,
					bitrate: source.bitrate,
					from: source.samplerate,
					to: encoder.samplerate,
					bufferSize: encoder.bufferSize
				});

				//Resample at the lower bitrate for better memory usage
				if(source.bitrate < encoder.bitrate){
					resampler.on('data',function(){
						that.queued++;
						//up-convert bit depth after resampling
						encoder.encode(inputs.map(btcv))
						.then(enc_suc,enc_err);
					});
					source.pipe(function(inputs){
						if(!that.recording){ return; }
						resampler.append(inputs);
					});
				}else{
					resampler.on('data',function(inputs){
						that.queued++;
						encoder.encode(inputs)
						.then(enc_suc,enc_err);
					});
					source.pipe(function(inputs){
						if(!that.recording){ return; }
						//down-convert bit depth before resampling
						resampler.append(inputs.map(btcv));
					});
				}
			}

			that.source = source;
			that.encoder = encoder;
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
		this.encoder.reset(hard);
	};

	Recorder.prototype.finish = function(){
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