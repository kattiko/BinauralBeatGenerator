// Audio context
let audioContext;
let gainNode;

// Oscillator pairs (for crossfading)
let activeOscillators = null;
let nextOscillators = null;

// Session state
let isPlaying = false;
let isPaused = false;
let startTime;
let pauseTime;
let currentSegmentIndex = 0;
let totalDuration = 0;
let elapsedTime = 0;
let segments = [];
let updateInterval;
let lastFrequencyChange = 0; // Track last frequency change
let currentBinauralFrequency = 0;

// Crossfade constants
const CROSSFADE_DURATION = 1; // Crossfade duration in seconds
const FADE_OVERLAP = 2; // Small delay between fade start times (seconds)
let isInCrossfade = false;
let pendingSegmentChange = false;

// DOM elements
const playButton = document.getElementById('play');
const restartButton = document.getElementById('restart');
const downloadButton = document.getElementById('download');
const instructionsTextarea = document.getElementById('instructions');
const baseToneInput = document.getElementById('baseTone');
const currentBeatDisplay = document.getElementById('current-beat');
const currentFrequencyDisplay = document.getElementById('current-frequency');
const timeRemainingDisplay = document.getElementById('time-remaining');
const progressBar = document.getElementById('progress');
const downloadStatusDisplay = document.getElementById('download-status');

// Add media session handling for mobile headset controls
function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Binaural Beats Session',
            artist: 'Binaural Beats Generator',
            album: 'Custom Binaural Beats',
        });

        navigator.mediaSession.setActionHandler('play', () => {
            // Only respond if we're not typing in the textarea
            if (document.activeElement !== instructionsTextarea) {
                resumePlaying();
            }
        });
        
        navigator.mediaSession.setActionHandler('pause', () => {
            // Only respond if we're not typing in the textarea
            if (document.activeElement !== instructionsTextarea) {
                pausePlaying();
            }
        });
        
        navigator.mediaSession.setActionHandler('stop', () => {
            // Only respond if we're not typing in the textarea
            if (document.activeElement !== instructionsTextarea) {
                stopPlaying();
            }
        });
    }
}

// Initialize audio context on user interaction
function initAudio() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Create gain node for volume control
        gainNode = audioContext.createGain();
        gainNode.gain.value = 0.2; // Set volume to 20%
        gainNode.connect(audioContext.destination);
        
        // Setup media session for headset controls
        setupMediaSession();
    }
}

// Create an oscillator pair (left + right) with individual gain nodes for crossfading
function createOscillatorPair(context) {
    // Use provided context or default to audioContext
    const ctx = context || audioContext;
    
    const leftOsc = ctx.createOscillator();
    const rightOsc = ctx.createOscillator();
    
    const leftGain = ctx.createGain();
    const rightGain = ctx.createGain();
    
    const merger = ctx.createChannelMerger(2);
    
    leftOsc.connect(leftGain);
    rightOsc.connect(rightGain);
    
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 1);
    
    // If using the main audio context, connect to gainNode
    // Otherwise, the caller will need to handle the connection
    if (ctx === audioContext) {
        merger.connect(gainNode);
    }
    
    leftOsc.type = 'sine';
    rightOsc.type = 'sine';
    
    // Pre-initialize gain to zero to prevent pops on start
    leftGain.gain.value = 0;
    rightGain.gain.value = 0;
    
    return {
        left: leftOsc,
        right: rightOsc,
        leftGain: leftGain,
        rightGain: rightGain,
        merger: merger,
        started: false
    };
}

// Parse instructions from text input
function parseInstructions(text) {
    const segments = [];
    const parts = text.split(',').map(part => part.trim());
    
    for (const part of parts) {
        if (!part) continue;
        
        // Match patterns like "7 to 4hz 1 hr" or "4 hz 30min"
        const stableMatch = part.match(/^(\d+(?:\.\d+)?)\s*hz\s*(\d+(?:\.\d+)?)\s*(hr|min)$/i);
        const transitionMatch = part.match(/^(\d+(?:\.\d+)?)\s*(?:hz)?\s*to\s*(\d+(?:\.\d+)?)\s*hz\s*(\d+(?:\.\d+)?)\s*(hr|min)$/i);
        
        if (stableMatch) {
            // Stable frequency
            const frequency = parseFloat(stableMatch[1]);
            const duration = parseFloat(stableMatch[2]);
            const unit = stableMatch[3].toLowerCase();
            
            // Convert duration to milliseconds
            const durationMs = unit === 'hr' ? duration * 60 * 60 * 1000 : duration * 60 * 1000;
            
            segments.push({
                type: 'stable',
                startFreq: frequency,
                endFreq: frequency,
                duration: durationMs
            });
        } else if (transitionMatch) {
            // Transition frequency
            const startFreq = parseFloat(transitionMatch[1]);
            const endFreq = parseFloat(transitionMatch[2]);
            const duration = parseFloat(transitionMatch[3]);
            const unit = transitionMatch[4].toLowerCase();
            
            // Convert duration to milliseconds
            const durationMs = unit === 'hr' ? duration * 60 * 60 * 1000 : duration * 60 * 1000;
            
            segments.push({
                type: 'transition',
                startFreq: startFreq,
                endFreq: endFreq,
                duration: durationMs
            });
        }
    }
    
    return segments;
}

// Calculate total duration from segments
function calculateTotalDuration(segments) {
    return segments.reduce((total, segment) => total + segment.duration, 0);
}

// Format time as HH:MM:SS
function formatTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Update the frequencies for a specific oscillator pair
function updateOscillatorFrequencies(oscPair, binauralFreq, baseTone, ctx, time) {
    if (!oscPair) return;
    
    const halfBeatFreq = binauralFreq / 2;
    const leftFreq = baseTone - halfBeatFreq;
    const rightFreq = baseTone + halfBeatFreq;
    
    // Set frequencies for binaural beat
    const currentTime = time || (ctx ? ctx.currentTime : audioContext.currentTime);
    
    if (oscPair.left && oscPair.right) {
        oscPair.left.frequency.setValueAtTime(leftFreq, currentTime);
        oscPair.right.frequency.setValueAtTime(rightFreq, currentTime);
    }
    
    return { leftFreq, rightFreq };
}

// Perform a crossfade between the active and next oscillator pairs
function performCrossfade(nextSegmentIndex) {
    if (isInCrossfade) return;
    isInCrossfade = true;
    
    // Get the next segment
    const nextSegment = segments[nextSegmentIndex];
    if (!nextSegment) {
        isInCrossfade = false;
        return;
    }
    
    // Create new oscillator pair for next segment
    nextOscillators = createOscillatorPair();
    
    // Calculate starting frequency for next segment
    const baseTone = parseFloat(baseToneInput.value) || 432;
    const binauralFreq = nextSegment.startFreq;
    
    // Set initial frequencies for next oscillators
    updateOscillatorFrequencies(nextOscillators, binauralFreq, baseTone);
    
    // Current time for scheduling
    const currentTime = audioContext.currentTime;
    
    // Start the next oscillators with gain at 0 (already set in createOscillatorPair)
    nextOscillators.left.start(currentTime);
    nextOscillators.right.start(currentTime);
    nextOscillators.started = true;
    
    // Define timing for crossfade
    const fadeOutStartTime = currentTime;
    const fadeInStartTime = currentTime + FADE_OVERLAP; // Slightly delay fade-in to prevent volume dip
    const fadeOutEndTime = fadeOutStartTime + CROSSFADE_DURATION;
    const fadeInEndTime = fadeInStartTime + CROSSFADE_DURATION;
    
    // Smooth fade-in for new oscillators (using exponential for smoother audio transition)
    // Set very small value first (can't go to 0 with exponentialRampToValueAtTime)
    nextOscillators.leftGain.gain.setValueAtTime(0.001, fadeInStartTime);
    nextOscillators.rightGain.gain.setValueAtTime(0.001, fadeInStartTime);
    nextOscillators.leftGain.gain.exponentialRampToValueAtTime(1, fadeInEndTime);
    nextOscillators.rightGain.gain.exponentialRampToValueAtTime(1, fadeInEndTime);
    
    // Smooth fade-out for active oscillators if they exist
    if (activeOscillators && activeOscillators.started) {
        activeOscillators.leftGain.gain.setValueAtTime(1, fadeOutStartTime);
        activeOscillators.rightGain.gain.setValueAtTime(1, fadeOutStartTime);
        activeOscillators.leftGain.gain.exponentialRampToValueAtTime(0.001, fadeOutEndTime);
        activeOscillators.rightGain.gain.exponentialRampToValueAtTime(0.001, fadeOutEndTime);
        
        // Schedule disconnection and stopping after fade completes
        setTimeout(() => {
            try {
                // Set gain to zero immediately before stopping to prevent clicks
                activeOscillators.leftGain.gain.setValueAtTime(0, audioContext.currentTime);
                activeOscillators.rightGain.gain.setValueAtTime(0, audioContext.currentTime);
                
                // Stop oscillators
                activeOscillators.left.stop(audioContext.currentTime + 0.01);
                activeOscillators.right.stop(audioContext.currentTime + 0.01);
                
                // Clean up connections to prevent memory leaks
                activeOscillators.left.disconnect();
                activeOscillators.right.disconnect();
                activeOscillators.leftGain.disconnect();
                activeOscillators.rightGain.disconnect();
                activeOscillators.merger.disconnect();
            } catch (e) {
                console.log('Error stopping old oscillators:', e);
            }
        }, CROSSFADE_DURATION * 1000 + 10); // Add a tiny buffer
    }
    
    // Schedule cleanup after fade completes
    setTimeout(() => {
        // Set next oscillators as active
        activeOscillators = nextOscillators;
        nextOscillators = null;
        
        // Set the new segment index and update UI
        currentSegmentIndex = nextSegmentIndex;
        updateCurrentSegmentDisplay();
        
        isInCrossfade = false;
        
        // If there was a pending segment change during crossfade, process it now
        if (pendingSegmentChange) {
            pendingSegmentChange = false;
            const newSegmentIndex = findCurrentSegment(elapsedTime);
            if (newSegmentIndex !== currentSegmentIndex && newSegmentIndex < segments.length) {
                performCrossfade(newSegmentIndex);
            }
        }
    }, (CROSSFADE_DURATION + FADE_OVERLAP) * 1000 + 50); // Wait until both fades complete
}

// Start playing binaural beats
function startPlaying() {
    initAudio();
    
    // Parse instructions
    segments = parseInstructions(instructionsTextarea.value);
    
    if (segments.length === 0) {
        alert('Please enter valid instructions.');
        return;
    }
    
    // Calculate total duration
    totalDuration = calculateTotalDuration(segments);
    
    // Create first oscillator pair
    activeOscillators = createOscillatorPair();
    
    // Start first segment
    currentSegmentIndex = 0;
    lastFrequencyChange = 0;
    elapsedTime = 0;
    isPaused = false;
    
    // Set initial frequencies
    const baseTone = parseFloat(baseToneInput.value) || 432;
    const segment = segments[currentSegmentIndex];
    const { leftFreq, rightFreq } = updateOscillatorFrequencies(activeOscillators, segment.startFreq, baseTone);
    
    // Update frequency displays
    currentBinauralFrequency = segment.startFreq;
    currentFrequencyDisplay.textContent = `Current Binaural Beat: ${segment.startFreq.toFixed(1)} Hz`;
    
    // Set current beat display
    updateCurrentSegmentDisplay();
    
    // Start oscillators with smooth ramp-up to prevent clicks
    const currentTime = audioContext.currentTime;
    activeOscillators.left.start(currentTime);
    activeOscillators.right.start(currentTime);
    activeOscillators.started = true;
    
    // Start with zero volume and ramp up to prevent clicks
    activeOscillators.leftGain.gain.setValueAtTime(0.001, currentTime);
    activeOscillators.rightGain.gain.setValueAtTime(0.001, currentTime);
    activeOscillators.leftGain.gain.exponentialRampToValueAtTime(1, currentTime + 0.1);
    activeOscillators.rightGain.gain.exponentialRampToValueAtTime(1, currentTime + 0.1);
    
    // Set start time
    startTime = audioContext.currentTime;
    
    // Update UI
    playButton.textContent = 'Pause';
    isPlaying = true;
    
    // Start update interval
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(updateBeatProgress, 100);
    
    // Update media session state
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
    }
}

// Update the current segment display
function updateCurrentSegmentDisplay() {
    if (currentSegmentIndex >= segments.length) return;
    
    const segment = segments[currentSegmentIndex];
    currentBeatDisplay.textContent = `Current: ${segment.startFreq}Hz ${segment.type === 'transition' ? 'to ' + segment.endFreq + 'Hz' : ''}`;
}

// Calculate segment times
function calculateSegmentTimes() {
    let times = [];
    let accumulatedTime = 0;
    
    for (let i = 0; i < segments.length; i++) {
        accumulatedTime += segments[i].duration;
        times.push(accumulatedTime);
    }
    
    return times;
}

// Find current segment based on elapsed time
function findCurrentSegment(elapsedTime) {
    let accumulatedTime = 0;
    
    for (let i = 0; i < segments.length; i++) {
        accumulatedTime += segments[i].duration;
        if (elapsedTime < accumulatedTime) {
            return i;
        }
    }
    
    return segments.length - 1; // Return last segment if over time
}

// Calculate time within current segment
function getTimeInSegment(segmentIndex, elapsedTime) {
    let segmentStartTime = 0;
    
    for (let i = 0; i < segmentIndex; i++) {
        segmentStartTime += segments[i].duration;
    }
    
    return elapsedTime - segmentStartTime;
}

// Check if we need to transition to next segment
function checkSegmentTransition() {
    // Find which segment we should be in based on elapsed time
    const targetSegmentIndex = findCurrentSegment(elapsedTime);
    
    // If we need to change segments and not already in a crossfade
    if (targetSegmentIndex !== currentSegmentIndex && !isInCrossfade) {
        performCrossfade(targetSegmentIndex);
    } else if (isInCrossfade) {
        // If already in a crossfade, mark that we have a pending change
        pendingSegmentChange = true;
    }
}

// Update current sound based on progress within segment
function updateCurrentSegmentFrequency() {
    if (currentSegmentIndex >= segments.length) return;
    
    const segment = segments[currentSegmentIndex];
    const baseTone = parseFloat(baseToneInput.value) || 432;
    
    // Calculate time within the current segment
    const timeInSegment = getTimeInSegment(currentSegmentIndex, elapsedTime);
    const progress = timeInSegment / segment.duration;
    
    // Calculate current frequency based on progress
    let currentFreq;
    if (segment.type === 'stable') {
        currentFreq = segment.startFreq;
    } else {
        // Linear interpolation between start and end frequencies
        currentFreq = segment.startFreq + (segment.endFreq - segment.startFreq) * progress;
    }
    
    // Save current binaural frequency for display
    currentBinauralFrequency = currentFreq;
    
    // Update active oscillators
    const { leftFreq, rightFreq } = updateOscillatorFrequencies(activeOscillators, currentFreq, baseTone);
    
    // Update display frequencies
    currentFrequencyDisplay.textContent = `Current Binaural Beat: ${currentFreq.toFixed(1)} Hz`;
}

// Update progress bar and time displays
function updateBeatProgress() {
    if (!isPlaying) return;
    
    // Calculate new elapsed time
    elapsedTime = (audioContext.currentTime - startTime) * 1000;
    
    // Update progress bar
    const progress = Math.min(elapsedTime / totalDuration * 100, 100);
    progressBar.style.width = `${progress}%`;
    
    // Update time display
    const remainingTime = Math.max(0, totalDuration - elapsedTime);
    timeRemainingDisplay.textContent = `Time: ${formatTime(remainingTime)}`;
    
    // Check if we need to move to a new segment
    checkSegmentTransition();
    
    // Update frequency within current segment
    updateCurrentSegmentFrequency();
    
    // If we've reached the end, stop playing
    if (elapsedTime >= totalDuration) {
        stopPlaying();
    }
}

// Toggle play/pause
function togglePlayPause() {
    if (isPlaying) {
        pausePlaying();
    } else {
        if (isPaused) {
            resumePlaying();
        } else {
            startPlaying();
        }
    }
}

// Pause playback
function pausePlaying() {
    if (!isPlaying) return;
    
    pauseTime = audioContext.currentTime;
    audioContext.suspend();
    playButton.textContent = 'Play';
    isPlaying = false;
    isPaused = true;
    clearInterval(updateInterval);
    
    // Update media session state
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
    }
}

// Resume playback
function resumePlaying() {
    if (isPlaying || !isPaused) return;
    
    audioContext.resume();
    playButton.textContent = 'Pause';
    isPlaying = true;
    
    // Adjust start time to account for pause
    startTime = audioContext.currentTime - (elapsedTime / 1000);
    
    // Restart update interval
    updateInterval = setInterval(updateBeatProgress, 100);
    
    // Update media session state
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
    }
}

// Clean up oscillators safely
function cleanupOscillators() {
    const currentTime = audioContext ? audioContext.currentTime : 0;
    
    // Function to safely stop and disconnect an oscillator pair
    const safeCleanup = (oscPair) => {
        if (!oscPair || !oscPair.started) return;
        
        try {
            // First set gains to zero to prevent pops
            oscPair.leftGain.gain.setValueAtTime(0, currentTime);
            oscPair.rightGain.gain.setValueAtTime(0, currentTime);
            
            // Schedule stop slightly after gain change
            oscPair.left.stop(currentTime + 0.01);
            oscPair.right.stop(currentTime + 0.01);
            
            // Disconnect everything
            setTimeout(() => {
                try {
                    oscPair.left.disconnect();
                    oscPair.right.disconnect();
                    oscPair.leftGain.disconnect();
                    oscPair.rightGain.disconnect();
                    oscPair.merger.disconnect();
                } catch (e) {
                    console.log('Error disconnecting:', e);
                }
            }, 50);
        } catch (e) {
            console.log('Error stopping oscillators:', e);
        }
    };
    
    // Clean up active and next oscillators
    safeCleanup(activeOscillators);
    safeCleanup(nextOscillators);
    
    activeOscillators = null;
    nextOscillators = null;
}

// Stop playback
function stopPlaying() {
    cleanupOscillators();
    
    playButton.textContent = 'Play';
    isPlaying = false;
    isPaused = false;
    isInCrossfade = false;
    pendingSegmentChange = false;
    elapsedTime = 0;
    currentSegmentIndex = 0;
    
    clearInterval(updateInterval);
    
    // Reset displays
    currentBeatDisplay.textContent = 'Current: Not playing';
    timeRemainingDisplay.textContent = 'Time: --:--:--';
    currentFrequencyDisplay.textContent = 'Current Binaural Beat: 0.0 Hz';
    progressBar.style.width = '0%';
    
    // Update media session state
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
    }
}

// Handle restart button
function handleRestart() {
    // First completely stop and clean up
    if (isPlaying || isPaused) {
        stopPlaying();
        
        // Small delay to ensure clean state before starting again
        setTimeout(() => {
            startPlaying();
        }, 200);
    } else {
        startPlaying();
    }
}

// ====== AUDIO DOWNLOAD FUNCTIONALITY ======

// Convert a AudioBuffer to a WAV format array buffer
function audioBufferToWav(audioBuffer) {
    // Get audio data
    const numOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM format (linear quantization)
    const bitDepth = 16; // 16-bit depth
    
    // Get channel data
    const channelData = [];
    for(let channel = 0; channel < numOfChannels; channel++) {
        channelData.push(audioBuffer.getChannelData(channel));
    }
    
    // Calculate required sizes
    const dataLength = channelData[0].length * numOfChannels * (bitDepth / 8);
    const buffer = new ArrayBuffer(44 + dataLength); // 44 bytes for the header
    const view = new DataView(buffer);
    
    // Write WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true); // 36 + subchunk2Size
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM format requires 16 bytes
    view.setUint16(20, format, true);
    view.setUint16(22, numOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numOfChannels * (bitDepth / 8), true); // Byte rate
    view.setUint16(32, numOfChannels * (bitDepth / 8), true); // Block align
    view.setUint16(34, bitDepth, true);
    
    // Write data subchunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);
    
    // Write audio data (interleaved)
    const offset = 44;
    
    // Converting Float32Array (range -1.0 to 1.0) to 16-bit PCM (range -32768 to 32767)
    if (numOfChannels === 2) {
        // Optimized path for stereo (most common case)
        const left = channelData[0];
        const right = channelData[1];
        
        for (let i = 0; i < left.length; i++) {
            // Convert float to int16
            const leftSample = Math.max(-1, Math.min(1, left[i]));
            const rightSample = Math.max(-1, Math.min(1, right[i]));
            
            // Apply slight limiter to avoid clipping
            const leftLimited = leftSample * 0.98;
            const rightLimited = rightSample * 0.98;
            
            // Convert to 16-bit and write
            view.setInt16(offset + (i * 4), leftLimited * 32767, true);
            view.setInt16(offset + (i * 4) + 2, rightLimited * 32767, true);
        }
    } else {
        // Generic path for any number of channels (mono, surround, etc.)
        let position = 0;
        for (let i = 0; i < channelData[0].length; i++) {
            for (let channel = 0; channel < numOfChannels; channel++) {
                const sample = Math.max(-1, Math.min(1, channelData[channel][i]));
                // Apply slight limiter to avoid clipping
                const limited = sample * 0.98;
                view.setInt16(offset + position, limited * 32767, true);
                position += 2;
            }
        }
    }
    
    return buffer;
}

// Helper to write a string into a DataView
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Generate and download WAV file containing the binaural beats session
// Replace the generateAndDownloadAudio function with this chunked approach

// Generate and download WAV file containing the binaural beats session using chunked rendering
// Replace the generateAndDownloadAudio function with this chunked approach

// Generate and download WAV file containing the binaural beats session using chunked rendering
async function generateAndDownloadAudio() {
    // Check if valid instructions exist
    const parsedSegments = parseInstructions(instructionsTextarea.value);
    if (parsedSegments.length === 0) {
        alert('Please enter valid instructions first.');
        return;
    }
    
    // Update status and button appearance
    downloadStatusDisplay.textContent = 'Preparing audio file...';
    downloadButton.disabled = true;
    downloadButton.innerHTML = '<span class="spinner"></span> Processing...';
    downloadButton.classList.add('processing');
    
    // Parse segments and get total duration
    const sessionSegments = parsedSegments;
    const sessionDuration = calculateTotalDuration(sessionSegments);
    const sessionLengthSeconds = Math.ceil(sessionDuration / 1000);
    
    // Get base tone frequency
    const baseTone = parseFloat(baseToneInput.value) || 432;
    
    // Calculate total size estimate for user feedback
    const totalSizeEstimateMB = (sessionLengthSeconds * 44100 * 4 / 1024 / 1024).toFixed(1); // 4 bytes per sample (16-bit stereo)
    
    // Update status with size info
    downloadStatusDisplay.textContent = `Preparing ${totalSizeEstimateMB}MB audio file...`;
    
    try {
        // Set up progress tracking
        let overallProgress = 0;
        progressBar.style.width = '0%';
        
        // Define chunk size (30 minutes per render chunk)
        const CHUNK_SIZE_SECONDS = 30 * 60; // 30 minutes per chunk
        
        // Define output file size limit (~1GB to be safely under 2GB limit)
        const MAX_OUTPUT_SAMPLES = 120000000; // About 1GB for stereo 16-bit WAV
        const MAX_OUTPUT_SECONDS = Math.floor(MAX_OUTPUT_SAMPLES / 44100);
        
        // Calculate how many output files we'll need
        const outputFileCount = Math.ceil(sessionLengthSeconds / MAX_OUTPUT_SECONDS);
        
        // Generate timestamp for filenames
        const now = new Date();
        const timestamp = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
        
        // Create wrapper div for download links if multiple files
        let downloadContainer = null;
        if (outputFileCount > 1) {
            downloadContainer = document.createElement('div');
            downloadContainer.id = 'download-links';
            downloadContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; background: white; padding: 15px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); max-width: 300px; z-index: 1000;';
            
            const header = document.createElement('h3');
            header.textContent = 'Your audio files (download all)';
            header.style.marginTop = '0';
            downloadContainer.appendChild(header);
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '×';
            closeBtn.style.cssText = 'position: absolute; top: 5px; right: 10px; background: none; border: none; font-size: 18px; cursor: pointer;';
            closeBtn.onclick = () => document.body.removeChild(downloadContainer);
            downloadContainer.appendChild(closeBtn);
            
            document.body.appendChild(downloadContainer);
        }
        
        // Process each output file
        for (let fileIndex = 0; fileIndex < outputFileCount; fileIndex++) {
            // Calculate time range for this file
            const fileStartTime = fileIndex * MAX_OUTPUT_SECONDS;
            const fileEndTime = Math.min((fileIndex + 1) * MAX_OUTPUT_SECONDS, sessionLengthSeconds);
            const fileDuration = fileEndTime - fileStartTime;
            
            // Update status
            downloadStatusDisplay.textContent = `Processing file ${fileIndex + 1}/${outputFileCount}...`;
            downloadButton.innerHTML = `<span class="spinner"></span> File ${fileIndex + 1}/${outputFileCount}`;
            
            // Create a list to track rendered chunks for this file
            const fileChunks = [];
            
            // Split file time range into smaller processing chunks
            const fileChunkCount = Math.ceil(fileDuration / CHUNK_SIZE_SECONDS);
            
            // Process each chunk within this file
            for (let chunkIndex = 0; chunkIndex < fileChunkCount; chunkIndex++) {
                const chunkStartTime = fileStartTime + (chunkIndex * CHUNK_SIZE_SECONDS);
                const chunkEndTime = Math.min(fileStartTime + ((chunkIndex + 1) * CHUNK_SIZE_SECONDS), fileEndTime);
                const chunkDuration = chunkEndTime - chunkStartTime;
                
                // Update status
                downloadStatusDisplay.textContent = `File ${fileIndex + 1}/${outputFileCount}, chunk ${chunkIndex + 1}/${fileChunkCount}...`;
                downloadButton.innerHTML = `<span class="spinner"></span> Processing...`;
                
                // Render this chunk
                const chunkBuffer = await renderAudioChunk(
                    sessionSegments, 
                    chunkStartTime, 
                    chunkDuration, 
                    baseTone,
                    (progress) => {
                        // Calculate overall progress across all files and chunks
                        const singleChunkWeight = 1 / (outputFileCount * fileChunkCount);
                        const baseProgress = (fileIndex * fileChunkCount + chunkIndex) * singleChunkWeight * 100;
                        const chunkContribution = progress * singleChunkWeight;
                        progressBar.style.width = `${baseProgress + chunkContribution}%`;
                    }
                );
                
                // Store the chunk
                fileChunks.push(chunkBuffer);
                
                // Update progress
                const overallProgress = ((fileIndex * fileChunkCount + chunkIndex + 1) / (outputFileCount * fileChunkCount)) * 90;
                progressBar.style.width = `${overallProgress}%`;
            }
            
            // Update status
            downloadStatusDisplay.textContent = `Creating file ${fileIndex + 1}/${outputFileCount}...`;
            downloadButton.innerHTML = '<span class="spinner"></span> Finalizing...';
            
            // Combine the chunks for this file
            const fileBuffer = combineAudioChunks(fileChunks);
            
            // Convert to WAV
            const wavBuffer = audioBufferToWav(fileBuffer);
            
            // Create a blob and trigger download
            const blob = new Blob([wavBuffer], { type: 'audio/wav' });
            
            // Generate filename
            const partLabel = outputFileCount > 1 ? `_part${fileIndex + 1}` : '';
            const filename = `binaural_beats_${timestamp}${partLabel}.wav`;
            
            // Create download link
            const url = URL.createObjectURL(blob);
            
            if (outputFileCount === 1) {
                // Single file - download automatically
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } else {
                // Multiple files - add to download links container
                const linkWrapper = document.createElement('div');
                linkWrapper.style.margin = '10px 0';
                
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.textContent = `Part ${fileIndex + 1} (${Math.round(blob.size / 1024 / 1024)}MB)`;
                a.style.cssText = 'display: block; margin-bottom: 5px; color: blue; text-decoration: underline;';
                
                linkWrapper.appendChild(a);
                downloadContainer.appendChild(linkWrapper);
            }
            
            // Update progress
            progressBar.style.width = `${90 + (fileIndex + 1) / outputFileCount * 10}%`;
        }
        
        // Update status and reset progress bar
        progressBar.style.width = '100%';
        setTimeout(() => {
            progressBar.style.width = '0%';
        }, 1000);
        
        // Show completion message
        if (outputFileCount === 1) {
            downloadStatusDisplay.textContent = 'Download complete!';
        } else {
            downloadStatusDisplay.textContent = `Generated ${outputFileCount} files. Please download all parts.`;
        }
        
        downloadButton.innerHTML = 'Download';
        
        // Clear message after a delay (only if single file)
        if (outputFileCount === 1) {
            setTimeout(() => {
                downloadStatusDisplay.textContent = '';
            }, 5000);
        }
    } catch (error) {
        console.error('Error creating audio file:', error);
        downloadStatusDisplay.textContent = `Error: ${error.message}. Try smaller duration.`;
    } finally {
        // Reset button state
        downloadButton.disabled = false;
        downloadButton.innerHTML = 'Download';
        downloadButton.classList.remove('processing');
    }
}

// Function to render a specific chunk of audio for a specific time range
async function renderAudioChunk(segments, startTimeSeconds, durationSeconds, baseTone, progressCallback) {
    // Create offline context for just this chunk
    const sampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(2, sampleRate * durationSeconds, sampleRate);
    
    // Create master gain node for the offline context
    const masterGain = offlineCtx.createGain();
    masterGain.gain.value = 0.2; // 20% volume
    masterGain.connect(offlineCtx.destination);
    
    // Figure out which segments overlap with this chunk
    let currentSegmentStartTime = 0; // in seconds
    let overlappingSegments = [];
    
    for (let i = 0; i < segments.length; i++) {
        const segmentDurationSec = segments[i].duration / 1000;
        const segmentEndTime = currentSegmentStartTime + segmentDurationSec;
        
        // Check if this segment overlaps with our chunk
        if (segmentEndTime > startTimeSeconds && currentSegmentStartTime < startTimeSeconds + durationSeconds) {
            overlappingSegments.push({
                segment: segments[i],
                startTime: currentSegmentStartTime,
                endTime: segmentEndTime
            });
        }
        
        // Move to next segment
        currentSegmentStartTime = segmentEndTime;
    }
    
    // Process each overlapping segment
    for (let i = 0; i < overlappingSegments.length; i++) {
        const { segment, startTime, endTime } = overlappingSegments[i];
        
        // Calculate how this segment overlaps with our chunk
        const segmentStartInChunk = Math.max(0, startTime - startTimeSeconds);
        const segmentEndInChunk = Math.min(durationSeconds, endTime - startTimeSeconds);
        const segmentDurationInChunk = segmentEndInChunk - segmentStartInChunk;
        
        if (segmentDurationInChunk <= 0) continue;
        
        // Create oscillator pair for this segment portion
        const oscPair = createOscillatorPair(offlineCtx);
        oscPair.merger.connect(masterGain);
        
        // Calculate where in the segment we're starting
        const offsetIntoSegment = Math.max(0, startTimeSeconds - startTime);
        const segmentProgress = offsetIntoSegment / (segment.duration / 1000);
        
        // Function to calculate frequency at a specific point in the segment
        const getFrequencyAtProgress = (progress) => {
            if (segment.type === 'stable') {
                return segment.startFreq;
            } else {
                return segment.startFreq + (segment.endFreq - segment.startFreq) * progress;
            }
        };
        
        // Start oscillators at the correct chunk time
        oscPair.left.start(segmentStartInChunk);
        oscPair.right.start(segmentStartInChunk);
        
        // Set initial frequencies based on where we are in the segment
        const initialFreq = getFrequencyAtProgress(segmentProgress);
        updateOscillatorFrequencies(oscPair, initialFreq, baseTone, offlineCtx, segmentStartInChunk);
        
        // Set initial gain (use fade-in if at segment start)
        if (offsetIntoSegment < 0.1) {
            // Fade in at segment start
            oscPair.leftGain.gain.setValueAtTime(0.001, segmentStartInChunk);
            oscPair.rightGain.gain.setValueAtTime(0.001, segmentStartInChunk);
            oscPair.leftGain.gain.exponentialRampToValueAtTime(1, segmentStartInChunk + 0.1);
            oscPair.rightGain.gain.exponentialRampToValueAtTime(1, segmentStartInChunk + 0.1);
        } else {
            // Start at full volume if in middle of segment
            oscPair.leftGain.gain.setValueAtTime(1, segmentStartInChunk);
            oscPair.rightGain.gain.setValueAtTime(1, segmentStartInChunk);
        }
        
        // If transition segment, update frequencies at regular intervals
        if (segment.type === 'transition') {
            const updateInterval = 0.05; // Update every 50ms
            
            // Calculate start and end progress for this chunk within the segment
            const startProgress = segmentProgress;
            const endProgress = (offsetIntoSegment + segmentDurationInChunk) / (segment.duration / 1000);
            
            // Schedule frequency changes
            for (let p = startProgress; p <= endProgress; p += updateInterval / (segment.duration / 1000)) {
                const timeInChunk = segmentStartInChunk + (p - startProgress) * (segment.duration / 1000);
                if (timeInChunk >= segmentStartInChunk && timeInChunk <= segmentEndInChunk) {
                    const freq = getFrequencyAtProgress(Math.min(1, p));
                    updateOscillatorFrequencies(oscPair, freq, baseTone, offlineCtx, timeInChunk);
                }
            }
        }
        
        // Apply fade-out if this is the end of the segment
        const isSegmentEnd = Math.abs(segmentEndInChunk - durationSeconds) < 0.1 || 
                             Math.abs(endTime - (startTimeSeconds + segmentEndInChunk)) < 0.1;
                             
        if (isSegmentEnd && i < overlappingSegments.length - 1) {
            const fadeOutStart = segmentEndInChunk - Math.min(CROSSFADE_DURATION, segmentDurationInChunk/2);
            oscPair.leftGain.gain.setValueAtTime(1, fadeOutStart);
            oscPair.rightGain.gain.setValueAtTime(1, fadeOutStart);
            oscPair.leftGain.gain.exponentialRampToValueAtTime(0.001, segmentEndInChunk);
            oscPair.rightGain.gain.exponentialRampToValueAtTime(0.001, segmentEndInChunk);
        }
        
        // Stop the oscillators
        oscPair.left.stop(segmentEndInChunk + 0.01);
        oscPair.right.stop(segmentEndInChunk + 0.01);
    }
    
    // Set up a timer to report progress periodically during rendering
    let renderStartTime = Date.now();
    let progressReportInterval = setInterval(() => {
        // Estimate progress based on elapsed time vs expected duration
        const elapsed = (Date.now() - renderStartTime) / 1000;
        const estimatedProgress = Math.min(95, (elapsed / durationSeconds) * 100);
        if (progressCallback) progressCallback(estimatedProgress);
    }, 100);
    
    // Render the audio
    try {
        const renderedBuffer = await offlineCtx.startRendering();
        clearInterval(progressReportInterval);
        return renderedBuffer;
    } catch (error) {
        clearInterval(progressReportInterval);
        throw error;
    }
}

// Combine multiple AudioBuffers into one
function combineAudioChunks(audioChunks) {
    if (audioChunks.length === 0) {
        throw new Error("No audio chunks to combine");
    }
    
    if (audioChunks.length === 1) {
        return audioChunks[0]; // Just return the single chunk
    }
    
    // Get total length and create a new buffer
    const sampleRate = audioChunks[0].sampleRate;
    const numChannels = audioChunks[0].numberOfChannels;
    let totalLength = 0;
    
    // Calculate total length
    for (const chunk of audioChunks) {
        totalLength += chunk.length;
    }
    
    // Create new buffer of combined size
    const combinedBuffer = new AudioBuffer({
        numberOfChannels: numChannels,
        length: totalLength,
        sampleRate: sampleRate
    });
    
    // Copy data from each chunk
    let position = 0;
    for (const chunk of audioChunks) {
        for (let channel = 0; channel < numChannels; channel++) {
            const chunkData = chunk.getChannelData(channel);
            const combinedData = combinedBuffer.getChannelData(channel);
            
            // Copy this chunk's data into the combined buffer
            for (let i = 0; i < chunk.length; i++) {
                combinedData[position + i] = chunkData[i];
            }
        }
        position += chunk.length;
    }
    
    return combinedBuffer;
}

// Add this immediately after the last function (after the closing brace of generateAndDownloadAudio)
// This will set up the event listeners when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', function() {
    // Connect play button to togglePlayPause function
    playButton.addEventListener('click', togglePlayPause);
    
    // Connect restart button to handleRestart function
    restartButton.addEventListener('click', handleRestart);
    
    // Connect download button to generateAndDownloadAudio function
    downloadButton.addEventListener('click', generateAndDownloadAudio);

    // Optional: Add event listener for space key to toggle play/pause
document.addEventListener('keydown', function(event) {
    if (event.code === 'Space') {
        // Exit immediately if we're in the textarea
        if (document.activeElement === instructionsTextarea) {
            return;
        }
        
        // Otherwise prevent default and toggle play/pause
        event.preventDefault();
        event.stopPropagation(); // Stop event from bubbling up
        togglePlayPause();
    }
            // If we're in the textarea, allow default behavior (typing a space)
    });
}); // <- This closing bracket was missing
