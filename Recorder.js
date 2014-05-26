var AudioRecorder = (function(){

	var getUserMedia = navigator.getUserMedia ||
						navigator.webkitGetUserMedia ||
						navigator.mozGetUserMedia,
		AudioContext = window.AudioContext ||
						window.webkitAudioContext;

	function Recorder(enc_cons,opts){
		var actx = new AudioContext(),
			stereo, that = this;
		
		if(typeof opts !== 'object'){ opts = {}; }
		
		stereo = (opts.channels !== 1);
		this.recording = false;
		this.stopped = false;
		this.flushed = false;
		this.encoder = null;
		
		return Promise.all([
			new enc_cons({
				channels: opts.channels,
				mode: opts.mode,
				bitrate: 32, //WebAudio gives us samples in float32 arrays 
				samplerate: actx.sampleRate
			}),
			new Promise(function(resolve, reject){
				getUserMedia.call(navigator,{ video: false, audio: true }, resolve, reject);
			})
		]).then(function(arr){
			var encoder = arr[0],
				stream = arr[1],
				source, node;
				
			that.encoder = encoder;
			source = actx.createMediaStreamSource(stream);

			if(stereo){
				node = actx.createScriptProcessor(+opts.bufferSize || 4096, 2, 1);
				node.onaudioprocess = function(e){
					if(!that.recording){ return; }
					var left = e.inputBuffer.getChannelData(0),
						right = e.inputBuffer.getChannelData(1);
					that.flushed = false;
					encoder.encode([left,right])
					.then(null,opts.error);
				};
			}else{
				node = actx.createScriptProcessor(+opts.bufferSize || 4096, 1, 1);
				node.onaudioprocess = function(e){
					if(!that.recording){ return; }
					that.flushed = false;
					encoder.encode([e.inputBuffer.getChannelData(0)])
					.then(null,opts.error);
				};
			}
			source.connect(node);
			node.connect(actx.destination);
			
			that.stop = function(){
				this.recording = false;
				this.stopped = true;
				stream.stop(); //minimum to make the tab recording icon go away
				//source.disconnect();
				//node.disconnect();
			};
			return that;
		});
	}

	Recorder.prototype.record = function(){
		if(this.stopped){ throw new Error("Cannot use stopped recorder."); }
		this.recording = true;
	};
	Recorder.prototype.pause = function(){
		if(this.stopped){ throw new Error("Cannot use stopped recorder."); }
		this.recording = false;
	};
	Recorder.prototype.reset = function(){
		if(this.stopped){ throw new Error("Cannot use stopped recorder."); }
		this.recording = false;
		this.encoder.reset();
		//if(this.flushed){ this.encoder.reset(); }
		//else{ this.encoder.destroy(); //make new encoder}
	};
	Recorder.prototype.getRecording = function(){
		if(this.flushed){ return Promise.reject(new Error('No recording available.')); }
		this.flushed = true;
		return this.encoder.end();
	};
	
	return Recorder;

}());