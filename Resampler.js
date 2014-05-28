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
	
	function dispatchMessage(e){
		var data = e.data,
			outputs = data.outputs,
			olen = data.outputLength,
			bits = this.bits,
			offset = this.offset,
			bufsize = this.bufsize,
			toCopy = Math.min(this.bufsize - offset, olen),
			byteOffset = toCopy*(bits/8),
			cons = arrayTypes[bits];
		//append data to output buffers
		this.buffers.forEach(function(buffer,i){
			buffer.set(new cons(outputs[i], 0, toCopy), offset);
			console.log(buffer);
		},this);
		
		//check for buffer fill
		offset += toCopy;
		
		if(offset === this.bufsize){
			this.emit('data',this.buffers);
			
			 //handle overflow
			if(toCopy < olen){
				this.buffers = outputs.map(function(obuf){
					var buf = new cons(bufsize);
					buf.set(new cons(obuf, byteOffset));
					return buf;
				},this);
				this.offset = olen - toCopy;
			}else{
				this.buffers = this.buffers.map(function(){ return new cons(this.bufsize); },this);
				this.offset = 0;
			}
		}else{
			this.offset = offset;
		}
	}
	
	function Resampler(fromRate, toRate, bufsize, channels, bits) {
		var i, worker,
			that = this,
			buffers = [],
			ratio = fromRate / toRate,
			cons = arrayTypes[bits];

		if(!cons){ throw new Error("Invalid Bit Depth"); }
		if (fromRate <= 0 || toRate <= 0 || channels <= 0) {
			throw new Error("Invalid Resampler Settings");
		}
		
		bufsize = +bufsize || 4096;
		
		//Initialize channel buffer list
		for(i=0;i<channels;i++){
			buffers[i] = new cons(bufsize);
		}
		
		this.events = {};
		this.bits = bits;
		this.bufsize = bufsize;
		this.channels = channels;
		this.offset = 0;
		this.buffers = buffers;
		this.append = null;
		
		if (fromRate === toRate) {
			this.append = Bypass;
		} else {
			worker = new Worker(blobURL);
			worker.postMessage({
				cmd: "setup",
				channels: channels || 1,
				ratio: ratio,
				bits: bits
			});
			worker.addEventListener('message',dispatchMessage.bind(this),false);
			worker.addEventListener('error',function(e){ that.emit('error', e); }, false);
			this.worker = worker;
			this.append = Resample;
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

	function Bypass(inputs) {
		var inbuffers = inputs.map(function(a){ return a.buffer; }),
			inlength = inputs.reduce(function(acc,next){ return Math.min(acc, next.length); });
		dispatchMessage.call(this,{
			data: {
				outputs: inbuffers,
				outputLength: inlength
			}
		});
	}
	
	function Resample(inputs){
		var inbuffers = inputs.map(function(a){ return a.buffer; }),
			inlength = inputs.reduce(function(acc,next){ return Math.min(acc, next.length); },1/0);
		if(!isFinite(inlength)){ return; }
		this.worker.postMessage({
			cmd: "exec",
			inputs: inbuffers,
			inlength: inlength
		});//,inbuffers); Copy instead of of Transfer because the source buffers might be neutered.
	}	
	
	return Resampler;
	
	function workerFn(){	
		var arrayTypes = {
			8: Int8Array,
			16: Int16Array,
			32: Float32Array,
			64: Float64Array
		};
		var i, cons, exec,
			bits, ratio, lastWeights;
	
		self.addEventListener('message',function(e){
			"use strict";
			var data = e.data,
				ilen, olen,
				bytelen,
				ibufs, obufs;
			switch(data.cmd){
			case "exec":
				//TODO: handle maximum output buffer sizes
				ilen = data.inlength;
				olen = Math.floor(ilen/ratio);
				bytelen = olen*(bits/8);
				ibufs = data.inputs;
				obufs = ibufs.map(function(){ return new ArrayBuffer(bytelen); });
				exec(
					ibufs.map(function(b){ return new cons(b,0,ilen); }),
					obufs.map(function(b){ return new cons(b,0,olen); })
				);
				self.postMessage({
					outputs: obufs,
					outputLength: olen
				},obufs);
				break;
			case "setup":
				bits = data.bits;
				ratio = data.ratio;
				cons = arrayTypes[bits];
				lastWeights = new Float32Array(data.channels);
				if (ratio < 1) {
					// Use generic linear interpolation for upsampling
					exec = LinearInterp.bind(this,data.ratio,new cons(data.channels),data.channels);
					for(i=0;i<data.channels;i++){ lastWeights[i] = 1; }
				} else {
					//Downsampling based on algorithm by Grant Galitz
					//https://github.com/grantgalitz/XAudioJS
					exec = MultiTap.bind(this,data.ratio,new cons(data.channels),new Uint8Array(data.channels),data.channels);
				}
				
			}
		},false);

		function LinearInterp(ratioWeight, lastInputs, channels, inputs, outputs){
			var i, data;
			for(i=0;i<channels;i++){
				data = MonoLinearInterp(ratioWeight, lastInputs[i], lastWeights[i], inputs[i], outputs[i]);
				lastInputs[i] = data.lastInput;
				lastWeights[i] = data.lastWeights;
			}
		}
		
		function MonoLinearInterp(ratioWeight, lastInput, weight, inBuffer, outBuffer) {
			var inLength = inBuffer.length,
				outLength = outBuffer.length,
				firstWeight = 0,
				secondWeight = 0,
				inputOffset = 0,
				outputOffset = 0;
				
			if(inLength > 0 && outLength > 0){		
				for (; outputOffset < outLength && weight < 1; weight += ratioWeight) {
					secondWeight = weight % 1;
					firstWeight = 1 - secondWeight;
					outBuffer[outputOffset++] = (lastInput * firstWeight) + (inBuffer[0] * secondWeight);
				}
				weight -= 1;
				for (inLength -= channels, inputOffset = Math.floor(weight); outputOffset < outLength && inputOffset < bufferLength;) {
					secondWeight = weight % 1;
					firstWeight = 1 - secondWeight;
					outBuffer[outputOffset++] = (inBuffer[inputOffset] * firstWeight) + (inBuffer[inputOffset+1] * secondWeight);
					weight += ratioWeight;
					inputOffset = Math.floor(weight);
				}
				lastInput = inBuffer[inputOffset];
				weight = weight % 1;
			}else{ inputOffset = -1; }
			return {
				//inputOffset: inputOffset+1,
				//outputOffset: outputOffset,
				lastInput: lastInput,
				lastWeight: weight
			};
		}

		function MultiTap(ratioWeight, lastOutputs, tailExists, channels, inputs, outputs){
			var i, data;
			for(i=0;i<channels;i++){				
				data = MonoMultiTap(ratioWeight, lastOutputs[i], lastWeights[i], tailExists[i], inputs[i], outputs[i]);
				lastOutputs[i] = data.lastOutput;
				lastWeights[i] = data.lastWeights;
				tailExists[i] = data.tailExists;
			}
		}
		
		function MonoMultiTap(ratioWeight, lastOutput, lastWeight, tailExists, inBuffer, outBuffer) {
			var inLength = inBuffer.length,
				outLength = outBuffer.length,
				amountToNext = 0,
				inputOffset = 0,
				outputOffset = 0,
				currentPosition = 0,
				weight, output;
			
			if (inLength > 0 && outLength > 0){
				do {
					if (tailExists === 1) {
						weight = lastWeight;
						output = lastOutput;
						tailExists = 0;
					} else {
						weight = ratioWeight;
						output = 0;
					}
					while (weight > 0 && inputOffset < inLength) {
						amountToNext = 1 + inputOffset - currentPosition;
						if (weight >= amountToNext) {
							output += inBuffer[inputOffset++] * amountToNext;
							currentPosition = inputOffset;
							weight -= amountToNext;
						} else {
							output += inBuffer[inputOffset] * weight;
							currentPosition += weight;
							weight = 0;
						}
					}
					if (weight != 0) { break; }
					outBuffer[outputOffset++] = output / ratioWeight;
				} while (inputOffset < inLength && outputOffset < outLength);
					
				lastWeight = weight;
				lastOutput = output;
				tailExists = 1;
			}	
			return {
				//inputOffset: inputOffset,
				//outputOffset: outputOffset,
				lastWeight: lastWeight,
				lastOutput: lastOutput,
				tailExists: tailExists
			};
		}
	}
}());