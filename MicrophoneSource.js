var MicrophoneSource = (function(){

	var getUserMedia = navigator.getUserMedia ||
						navigator.webkitGetUserMedia ||
						navigator.mozGetUserMedia,
		AudioContext = window.AudioContext ||
						window.webkitAudioContext;

	function MicrophoneSource(opts){
		var streamp,
			that = this;
		
		if(typeof opts !== 'object'){ opts = {}; }
		
		streamp = new Promise(function(resolve, reject){
			getUserMedia.call(navigator,{ video: false, audio: true }, resolve, reject);
		});
		
		return streamp.then(function(stream){
			var actx = new AudioContext(),
				channels = +opts.channels || 2,
				handlers = [],
				source = actx.createMediaStreamSource(stream),
				node = actx.createScriptProcessor(+opts.bufferSize || 4096, channels, 1);
				
			source.connect(node);
			node.connect(actx.destination);

			node.addEventListener('audioprocess',function(e){
				var i, data = [],
					buffer = e.inputBuffer;
				for(i=0;i<channels;i++){ data[i] = buffer.getChannelData(i); }
				handlers.forEach(function(h){ h.call(that,data); });
			},false);
			
			that.bitrate = 32; // WebAudio gives us samples in float32 arrays
			that.samplerate = actx.sampleRate;
			that.channels = channels;
			
			that.pipe = function(h){ handlers.push(h); };
			that.unpipe = function(h){
				var i = handlers.indexOf(h);
				if(~i){ handlers.splice(i,1); }
			};
			
			that.stop = function(){
				//Minimum to make the tab recording icon go away
				stream.stop();
				//Not sure if this is helpful or not; could improve GC
				source.disconnect();
				node.disconnect();
			};
			return that;
		});
	}
	
	return MicrophoneSource;

}());