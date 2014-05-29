//JavaScript Audio Resampler

var Resampler = (function(){
	"use strict";

	var blobURL = URL.createObjectURL(
		new Blob(
			['(' + workerFn.toString() + ')();'],
			{type: "text/javascript"}
		)
	);

	var arrayTypes = {
		8: Int8Array,
		16: Int16Array,
		32: Float32Array,
		64: Float64Array
	};

	function Resampler(opts){
		var worker, that = this,
			fromRate = +opts.from || 0,
			toRate = +opts.to || 0,
			channels = +opts.channels || 0,
			cons = arrayTypes[opts.bitrate] || Float32Array;

		//Perform some checks:
		if (fromRate <= 0 || toRate <= 0 || channels <= 0) {
			throw new Error("Invalid Resampler Settings");
		}

		this.events = {};
		if (fromRate === toRate) {
			//Bypass- copy inputs to outputs of the appropriate type
			//TODO: make this respect the output buffer size option
			this.append = function(inputs) {
				this.emit('data',inputs.map(function(a){ return new cons(a); }));
			};
			this.flush = function(){
				var i, buffers = [];
				for(i = 0; i < channels; ++i){ buffers.push(new ArrayBuffer(0)); }
				this.emit('data',buffers);
			};
		} else {
			worker = new Worker(blobURL);
			worker.postMessage({
				cmd: "init",
				bitrate: opts.bitrate,
				channels: channels,
				ratio: fromRate / toRate,
				outLength: +opts.bufferSize || 4096
			});
			worker.addEventListener('message',function(e){
				that.emit('data',e.data);
			},false);
			worker.addEventListener('error',function(e){
				console.log(e);
				that.emit('error',e);
			},false);
			this.append = function(inputs){
				worker.postMessage({
					cmd: "exec",
					inputs: inputs
				});
			};
			this.flush = function(){ worker.postMessage({cmd: "flush"}); };
		}
	}

	Resampler.prototype.on = function(ename, handler){
		if(!this.events.hasOwnProperty(ename)){
			this.events[ename] = [handler];
		}else{
			this.events[ename].push(handler);
		}
	};

	Resampler.prototype.off = function(ename, handler){
		var i, evlist = this.events[ename];
		if(!evlist){ return; }
		i = evlist.indexOf(handler);
		if(~i){ evlist.splice(i,1); }
	};

	Resampler.prototype.emit = function(ename, obj){
		var evlist = this.events[ename];
		if(!evlist){ return; }
		evlist.forEach(function(h){ h.call(this, obj); }, this);
	}

	return Resampler;

	function workerFn(){
		"use strict";
		var resampler = null,
			buffers = null,
			excessLength = 0,
			channels,
			olen, cons;

		self.addEventListener('message',function(e){
			"use strict";
			var data = e.data,
				i, ratio, len;
			switch(data.cmd){
			case "init":
				cons = {
					8: Int8Array,
					16: Int16Array,
					32: Float32Array,
					64: Float64Array
				}[data.bitrate] || Float32Array;
				ratio = data.ratio;
				channels = data.channels;
				olen = data.outLength;
				buffers = [];
				for(i = 0; i < channels; ++i){ buffers.push(new cons(olen)); }
				resampler = new (ratio < 1?UpSampler:DownSampler)(ratio, channels);
				break;
			case "exec":
				len = Math.min.apply(Math, data.inputs.map(function(a){ return a.length; }));
				if(isFinite(len)){ Exec(data.inputs, len); }
				break;
			case "flush":
				Flush();
				break;
			}
		},false);

		//Re-use the same output buffers over and over,
		//copying them to the main thread when they become full
		function Exec(inArrays, inLength){
			var offsets, index,
				outArrays, outLength;

			//Acquire output arrays
			if(excessLength > 0){
				outLength = excessLength;
				index = olen - excessLength;
				outArrays = buffers.map(function(b){ return b.subarray(index); });
			}else{
				outLength = olen;
				outArrays = buffers;
			}

			do {
				offsets = resampler.exec(inLength, outLength, inArrays, outArrays);
				if(offsets.outputOffset === outLength){ //Filled the output buffers

					//copy output buffers to main thread
					self.postMessage(buffers);
					excessLength = 0;

					//If we exhausted the input, we're done.
					if(offsets.inputOffset === inLength){ break; }
					else{ //Otherwise, shift the inputs and reset the output arrays
						outArrays = buffers;
						inLength -= offsets.inputOffset;
						inArrays = inArrays.map(function(a){ return a.subarray(offsets.inputOffset); });
					}
				}else{ break; }
			}while(true);
			excessLength = outLength - offsets.outputOffset;
		}

		function Flush(){
			var nbufs, index;
			if(excessLength > 0){
				index = olen = excessLength;
				self.postMessage(buffers.map(function(b){ return b.subarray(index); }));
				excessLength = 0;
			}else{
				self.postMessage(buffers.map(function(){ return new cons(0); }));
			}
		}

		function DownSampler(ratio,channels){
			this.channels = channels;
			this.ratio = ratio;
			this.lastWeight = 0;
			this.tailExists = false;
			this.lastOutput = new Float64Array(channels);
			//TODO: create mono-optimized version
		}

		DownSampler.prototype.exec = MultiTapResample;

		/* 
		 * Each output sample consists of the sum of some window of input samples,
		 * plus some fraction of a prior sample and some fraction of a following
		 * sample, all scaled according to the resampling ratio.
		 */
		function MultiTapResample(inLength, outLength, inBuffers, outBuffers) {
			var ratioWeight = this.ratio,
				lastOutput = this.lastOutput,
				channels = this.channels,
				preFraction = 1,
				inputOffset = 0,
				outputOffset = 0,
				buffer, weight,
				start, sum, c, i;

			if (inLength > 0 && outLength > 0){
				//This will only be set to ratioWeight if we are
				//processing the first frame, in which case we rely
				//on lastOutput having been previously zero-initialized
				weight = this.tailExists?this.lastWeight:ratioWeight;
				do {
					if (weight >= preFraction) {
						for(c = 0; c < channels; ++c){ lastOutput[c] += inBuffers[c][inputOffset] * preFraction; }
						weight -= preFraction;
						start = inputOffset + 1;
						inputOffset = Math.min(start + Math.floor(weight), inLength);
						for(c = 0; c < channels; ++c){
							buffer = inBuffers[c];
							for (sum = 0, i = start; i < inputOffset; ++i) { sum += buffer[i];	}
							lastOutput[c] += sum;
						}
						weight -= (inputOffset - start);
					}
					//Note: weight can never go negative, as (inputOffset - start)
					//can never be larger than floor(weight)
					if (weight === 0) { break; }
					if (inputOffset >= inLength || outputOffset+1 >= outLength) {
						for(c = 0; c < channels; ++c){ lastOutput[c] += inBuffers[c][inputOffset] * weight; }
						break;
					} else {
						for(c = 0; c < channels; ++c){
							outBuffers[c][outputOffset] = (lastOutput[c] + inBuffers[c][inputOffset] * weight) / ratioWeight;
							lastOutput[c] = 0;
						}
						//Setup the next iteration of the loop
						preFraction = 1 - weight;
						weight = ratioWeight;
						outputOffset++;
					}
				} while (true);
				outputOffset++;
				this.lastWeight = weight;
				this.tailExists = true;
			}
			return {
				inputOffset: inputOffset,
				outputOffset: outputOffset
			};
		}

		function UpSampler(ratio, channels){
			this.channels = channels;
			this.ratio = ratio;
			this.lastWeight = 0;
			this.lastOutput = new Float64Array(channels);
		}

		function LinearInterpResample(inLength, outLength, inBuffers, outBuffers) {
			var ratioWeight = this.ratio,
				lastOutput = this.lastOutput,
				channels = this.channels,
				outputOffset = 0,
				inputOffset = 0,
				weight,	preweight,
				firstSamples,
				ibuf, c;

			if(inLength > 0 && outLength > 0){
				inputOffset = 1;
				weight = this.lastWeight;
				firstSamples = inBuffers.map(function(a){ return a[0]; });
				while(weight < 1 && outputOffset < outLength){
					preweight = 1 - weight;
					for(c = 0; c < channels; ++c){
						outBuffers[c][outputOffset] = (lastOutput[c] * preweight) + (firstSamples[c] * weight);
					}
					weight += ratioWeight;
					outputOffset++;
				}
				weight -= 1;
				while(outputOffset < outLength && inputOffset < inLength) {
					preweight = 1 - weight;
					for(c = 0; c < channels; ++c){
						ibuf = inBuffers[c];
						outBuffers[c][outputOffset] = (ibuf[inputOffset-1] * preweight) + (ibuf[inputOffset] * weight);
					}
					weight += ratioWeight;
					outputOffset++;
					if(weight >= 1){
						inputOffset++;
						weight -= 1;
					}
				}
				for(c = 0; c < channels; ++c){ lastOutput[c] = inBuffers[c][inputOffset]; }
				this.lastWeight = weight % 1;
			}
			return {
				inputOffset: inputOffset,
				outputOffset: outputOffset
			};
		}
	}
}());