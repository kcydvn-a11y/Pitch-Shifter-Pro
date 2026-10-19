(function() {
  // Marker toàn cục – nếu đã tồn tại thì thoát ngay
  if (window.__jungle_content_script_marker__) {
    console.log("[Jungle Content] Already injected, skipping re-execution");
    return;
  }
  window.__jungle_content_script_marker__ = true;
  'use strict';
  let _audioCtx = null;
  let _jungle = null;
  let _previousPlaybackRate = 1;
  let _previousPitch = 0;
  let _previousBoost = 0.8;
  let _previousPan = 0;
  let _previousSoundProfile = "proNatural";
  let transpose = true;
  let videoConnected = false;
  let _observer = null;
  let _analyser = null;
  let _currentBPM = null;
  let _currentKey = null;
  let currentVideoSrc = null;
  let isEnabled = false;
  let isHeld = false;
  const outputNodeMap = new Map();
  const videoListeners = new Map();
  const favoritesMap = new Map();
  let isCalculatingBPM = false;
  let _nonstopInterval = null;
  let _lastNonstopCheck = 0;
  // CẤU HÌNH GIAO DIỆN THỜI GIAN NONSTOP MỚI CHỐNG NÓNG MÁY (3 - 4 PHÚT)
  const NONSTOP_INTERACTION_INTERVAL = 180000; // Mô phỏng tương tác mỗi 3 phút (180000ms)
  const NONSTOP_COOLDOWN = 15000; // Cooldown 15 giây để tránh xử lý dồn dập xung đột lệnh
  const VIDEO_CHECK_FALLBACK_INTERVAL = 30000; // Dự phòng 30 giây kiểm tra trạng thái phẳng
  let _lastInteractionTime = Date.now();
  const PREDICTED_DIALOG_TIME = 300000;
  const INTERACTION_FREQUENCY_LONG = 240000; // Tần suất tối ưu cho video dài: đúng 4 phút / lần
  const INTERACTION_FREQUENCY_SHORT = 180000; // Tần suất tối ưu cho Shorts: 3 phút / lần
  const SCROLL_DELTA = 1; // Scroll nhẹ 1px để mimic tương tác mà không ảnh hưởng UI
  let _simulateInterval = null; // Biến toàn cục mới để kiểm soát
  let _currentWakeupInterval = null; // Biến bảo vệ mini-wakeup interval trong applyHeldSettings
  let currentRecordingVideoId = null; // Theo dõi video ID đang cover (hỗ trợ cả Shorts và video dài)
  let currentMediaRecorder = null; // Lưu recorder toàn cục để dừng tức thì
  let isCovering = false; // Biến khóa cover – ngăn bấm nhiều lần
  let hasLoggedInitialWakeup = false; // Thêm biến này ở đầu file (cùng các biến global khác)
  if (typeof Jungle === "undefined") {
    console.error("Jungle library is not loaded. Please include it in the extension.");
  }

  // =========================================================================
  // QUALITY PRESETS (Bảo toàn nguyên cấu hình dữ liệu thông minh của bạn)
  // =========================================================================
  const qualities = {
    low: {
      mimeType: 'video/webm;codecs=vp8,opus',
      videoBits: 1000000,
      audioBits: 96000,
      isAudioOnly: false
    },
    medium: {
      mimeType: 'video/webm;codecs=vp8,opus',
      videoBits: 2000000,
      audioBits: 128000,
      isAudioOnly: false
    },
    normal: {
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBits: 3000000,
      audioBits: 160_000,
      isAudioOnly: false
    },
    high: {
      mimeType: 'video/webm;codecs=av01,opus',
      videoBits: 5000000,
      audioBits: 192000,
      isAudioOnly: false
    },
    mp3: {
      mimeType: 'audio/webm;codecs=opus',
      audioBits: 320000,
      isAudioOnly: true
    }
  };
  // =========================================================================
  // QUALITY SELECTION MODAL (Giao diện tab tinh gọn, hiệu ứng mượt mà)
  // =========================================================================
  async function selectQuality(duration) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;z-index:9999;
    `;
      const modal = document.createElement('div');
      modal.style.cssText = `
      background:#fff;border-radius:16px;padding:32px;width:480px;
      box-shadow:0 10px 30px rgba(0,0,0,0.3);text-align:center;
      font-family:Roboto,Arial,sans-serif;position:relative;transition:all 0.3s ease;
    `;
      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'X';
      closeBtn.style.cssText = `
      position:absolute;top:10px;right:15px;background:none;border:none;
      font-size:20px;cursor:pointer;color:#666;transition:color 0.2s;
    `;
      closeBtn.onmouseover = () => {
        closeBtn.style.color = '#f44336';
      };
      closeBtn.onmouseout = () => {
        closeBtn.style.color = '#666';
      };
      const cleanup = () => {
        if (document.body.contains(overlay)) overlay.remove();
        window.removeEventListener('beforeunload', cleanup);
      };
      closeBtn.onclick = () => {
        resolve(null);
        cleanup();
      };
      modal.appendChild(closeBtn);
      const header = document.createElement('h2');
      header.textContent = 'Select Cover Quality';
      header.style.margin = '0 0 20px 0';
      header.style.fontSize = '24px';
      modal.appendChild(header);
      const tabContainer = document.createElement('div');
      tabContainer.style.cssText = `
      display:flex;justify-content:center;margin-bottom:20px;
    `;
      const tabVideo = document.createElement('button');
      tabVideo.textContent = 'Video';
      tabVideo.style.cssText = `
      padding:10px 30px;font-size:18px;border:none;cursor:pointer;
      background:#1967d2;color:white;border-radius:8px 0 0 8px;
      font-weight:bold;transition:all 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.2);
    `;
      tabVideo.onmouseover = () => {
        tabVideo.style.transform = 'scale(1.05)';
        tabVideo.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)';
      };
      tabVideo.onmouseout = () => {
        tabVideo.style.transform = 'scale(1)';
        tabVideo.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
      };
      const tabAudio = document.createElement('button');
      tabAudio.textContent = 'Audio';
      tabAudio.style.cssText = `
      padding:10px 30px;font-size:18px;border:none;cursor:pointer;
      background:#f0f0f0;color:#333;border-radius:0 8px 8px 0;
      font-weight:bold;transition:all 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.2);
    `;
      tabAudio.onmouseover = () => {
        tabAudio.style.transform = 'scale(1.05)';
        tabAudio.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)';
      };
      tabAudio.onmouseout = () => {
        tabAudio.style.transform = 'scale(1)';
        tabAudio.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
      };
      tabContainer.appendChild(tabVideo);
      tabContainer.appendChild(tabAudio);
      modal.appendChild(tabContainer);
      const desc = document.createElement('p');
      desc.textContent = 'Choose quality for your recording. Lower qualities are lighter.';
      desc.style.margin = '0 0 30px 0';
      desc.style.color = '#555';
      desc.style.fontSize = '16px';
      desc.style.lineHeight = '1.5';
      modal.appendChild(desc);
      const buttonContainer = document.createElement('div');
      buttonContainer.id = 'quality-buttons';
      modal.appendChild(buttonContainer);
      const calcSize = (v, a, isAudio = false) => {
        if (isAudio) return Math.round((a / 8 * duration) / 1024 / 1024);
        return Math.round(((v + a) / 8 * duration) / 1024 / 1024);
      };
      const showVideoButtons = () => {
        buttonContainer.innerHTML = '';
        tabVideo.style.background = '#1967d2';
        tabVideo.style.color = 'white';
        tabAudio.style.background = '#f0f0f0';
        tabAudio.style.color = '#333';
        createButton('low', 'Low Quality (VP8)', 'Lightest on system • Fastest', '#f0f0f0', '#000');
        createButton('medium', 'Medium Quality (VP8)', 'Small file • Fast recording', '#e0e0e0', '#000');
        createButton('normal', 'Normal Quality (VP9)', 'Balanced quality & size', '#bbbbbb', '#000');
        createButton('high', 'High Quality (AV1)', 'Sharpest video • Richest audio', '#1967d2', 'white');
      };
      const showAudioButtons = () => {
        buttonContainer.innerHTML = '';
        tabVideo.style.background = '#f0f0f0';
        tabVideo.style.color = '#333';
        tabAudio.style.background = '#e91e63';
        tabAudio.style.color = 'white';
        createButton('mp3', 'Audio Only', 'Lightweight • Easy share • Great sound (opus webm)', '#e91e63', 'white');
      };
      const createButton = (level, label, subtext, bg = '#f0f0f0', color = '#000') => {
        const q = qualities[level];
        const size = calcSize(q.videoBits, q.audioBits, q.isAudioOnly);
        const btn = document.createElement('button');
        btn.style.cssText = `
        width:100%;padding:14px;margin-bottom:12px;font-size:18px;
        border:none;border-radius:12px;background:${bg};color:${color};
        cursor:pointer;font-weight:bold;transition:all 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.1);
      `;
        btn.onmouseover = () => {
          btn.style.transform = 'scale(1.05)';
          btn.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)';
          btn.style.background = bg === '#f0f0f0' ? '#e0e0e0' : (bg === '#e91e63' ? '#d81b60' : bg);
        };
        btn.onmouseout = () => {
          btn.style.transform = 'scale(1)';
          btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
          btn.style.background = bg;
        };
        btn.innerHTML = `${label}<br><small style="font-weight:normal;color:${color==='#000'?'#666':'#eee'};">~${size} MB • ${subtext}</small>`;
        btn.onclick = () => {
          resolve(level);
          cleanup();
        };
        buttonContainer.appendChild(btn);
      };
      tabVideo.onclick = showVideoButtons;
      tabAudio.onclick = showAudioButtons;
      showVideoButtons();
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      overlay.onclick = e => {
        if (e.target === overlay) {
          resolve(null);
          cleanup();
        }
      };
      window.addEventListener('beforeunload', cleanup);
    });
  }
  // =========================
  // LOAD SENSOR (giữ nguyên)
  // =========================
  function createLoadSensor(video) {
    const WINDOW_MS = 2500;
    const FRAME_DROP_MS = 70;
    const samples = [];
    let lastFrameTime = performance.now();
    let stopped = false;
    if (typeof video.requestVideoFrameCallback !== 'function') {
      return {
        level: () => 'low',
        high: () => false,
        cool() {},
        stop() {}
      };
    }
    const cb = now => {
      if (stopped) return;
      if (now - lastFrameTime > FRAME_DROP_MS) samples.push(now);
      lastFrameTime = now;
      const cutoff = now - WINDOW_MS;
      while (samples.length && samples[0] < cutoff) samples.shift();
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    const getLevel = () => samples.length >= 8 ? 'high' : samples.length >= 3 ? 'medium' : 'low';
    return {
      level: getLevel,
      high: () => getLevel() === 'high',
      cool() {
        if (samples.length > 1) samples.splice(0, Math.floor(samples.length / 2));
      },
      stop() {
        stopped = true;
        samples.length = 0;
      }
    };
  }
  // =========================
  // BITRATE ADAPTER (giữ nguyên)
  // =========================
  function createBitrateAdapter(recorder, baseBits) {
    let current = baseBits;
    let stableTicks = 0;
    const MIN_BITS = 800000;
    const apply = () => {
      if (recorder?.state === 'recording' && 'videoBitsPerSecond' in recorder) {
        try {
          recorder.videoBitsPerSecond = Math.round(current);
        } catch (_) {}
      }
    };
    return {
      down() {
        stableTicks = 0;
        current = Math.max(current * 0.75, MIN_BITS);
        apply();
      },
      up() {
        if (++stableTicks < 3) return;
        stableTicks = 0;
        current = Math.min(current * 1.1, baseBits);
        apply();
      }
    };
  }
  // =========================
  // UTILITY: once event
  // =========================
  function once(target, event) {
    return new Promise(resolve => {
      const fn = () => {
        target.removeEventListener(event, fn);
        resolve();
      };
      target.addEventListener(event, fn);
    });
  }
  // =========================
  // MAIN COVER RECORDING (Đã khắc phục hoàn toàn rò rỉ RAM và Crash Codec)
  // =========================
  async function downloadCover() {
    if (isCovering) return;
    isCovering = true;
    let sarInterval = null;
    let loadSensor = null;
    let videoStream = null;
    let audioDestination = null;
    let progressInterval = null;
    let activeVideo = null;
    let stopRecording = null;
    try {
      if (!isEnabled || !videoConnected || !_jungle || !_audioCtx) {
        createToast("Extension not enabled or video not connected!", "error");
        isCovering = false;
        return;
      }
      activeVideo = Array.from(outputNodeMap.keys()).find(v => isVideoPlaying(v));
      if (!activeVideo) {
        createToast("No active video!", "error");
        isCovering = false;
        return;
      }
      // Tối ưu hóa: Lấy chính xác video ID thông qua cấu trúc URL API bản địa an toàn
      let videoId = "Unknown_ID";
      try {
        const parsedUrl = new URL(window.location.href);
        videoId = parsedUrl.searchParams.get("v");
        if (!videoId && parsedUrl.pathname.includes('/shorts/')) {
          const parts = parsedUrl.pathname.split('/');
          videoId = parts[parts.indexOf('shorts') + 1];
        }
      } catch (e) {
        const currentUrl = getRealVideoUrl();
        videoId = (currentUrl.match(/[?&]v=([^&]+)/) || currentUrl.match(/\/shorts\/([a-zA-Z0-9_-]{11})/))?.[1] || "Unknown_ID";
      }
      if (currentRecordingVideoId && currentRecordingVideoId !== videoId) {
        currentMediaRecorder?.stop();
        currentRecordingVideoId = null;
        currentMediaRecorder = null;
        isCovering = false;
        return;
      }
      currentRecordingVideoId = videoId;
      const savedCurrentTime = activeVideo.currentTime;
      const coverTitle = document.title.replace(/[-|] YouTube.*/g, "").trim() || "Unknown_Song";
      if (!isFinite(activeVideo.duration)) await once(activeVideo, 'loadedmetadata');
      const totalDuration = activeVideo.duration;
      if (!totalDuration || totalDuration <= 0) {
        createToast("Cannot determine video duration!", "error");
        isCovering = false;
        return;
      }
      const qualityLevel = await selectQuality(totalDuration);
      if (!qualityLevel) {
        isCovering = false;
        return;
      }
      const config = qualities[qualityLevel];
      if (!config) {
        isCovering = false;
        return;
      }
      let isMP3 = config.isAudioOnly;
      let mime = config.mimeType;
      // 🚀 BỘ CHỌN HẠ CẤP CODEC THÔNG MINH (ANTI-CRASH): 
      // Tự động kiểm tra và chuyển đổi về codec quốc dân nếu trình duyệt không hỗ trợ nén nặng AV1/VP9
      if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mime)) {
        console.warn(`[Jungle Media] MimeType ${mime} không được hỗ trợ trên thiết bị này, đang tự động chuyển hướng an toàn...`);
        mime = isMP3 ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8,opus';
      }
      createToast(`Recording ${isMP3 ? 'Audio' : 'cover'} (${qualityLevel.toUpperCase()}) — In your style! ✨`, "recording");
      await ensureAudioContext();
      activeVideo.currentTime = 0.1;
      await activeVideo.play();
      let lastTime = activeVideo.currentTime;
      let userInterrupted = false;
      audioDestination = _audioCtx.createMediaStreamDestination();
      _jungle.output.connect(audioDestination);
      let mixedStream;
      if (isMP3) {
        mixedStream = audioDestination.stream;
      } else {
        videoStream = activeVideo.captureStream();
        mixedStream = new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()]);
      }
      const mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: mime,
        ...(isMP3 ? {
          audioBitsPerSecond: config.audioBits
        } : {
          videoBitsPerSecond: config.videoBits,
          audioBitsPerSecond: config.audioBits
        })
      });
      currentMediaRecorder = mediaRecorder;
      const chunks = [];
      mediaRecorder.ondataavailable = e => {
        if (e.data?.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start();
      if (!isMP3) {
        loadSensor = createLoadSensor(activeVideo);
        const bitrateCtl = createBitrateAdapter(mediaRecorder, config.videoBits);
        sarInterval = setInterval(() => {
          const level = loadSensor.level();
          if (level === 'high') {
            bitrateCtl.down();
            loadSensor.cool();
          } else if (level === 'low') bitrateCtl.up();
        }, 4000);
      }
      // Định nghĩa và gắn bộ lắng nghe có định danh để gỡ bỏ sạch sẽ về sau
      stopRecording = () => {
        userInterrupted = true;
      };
      activeVideo.addEventListener('pause', stopRecording);
      activeVideo.addEventListener('seeking', stopRecording);
      activeVideo.addEventListener('ended', stopRecording);
      progressInterval = setInterval(() => {
        const current = activeVideo.currentTime;
        if (Math.abs(current - lastTime) > 1.5) userInterrupted = true;
        lastTime = current;
        updateToastProgress(Math.min(100, Math.round((current / totalDuration) * 100)));
        if (userInterrupted && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      }, 800);
      await once(mediaRecorder, 'stop');
      const finalBlob = new Blob(chunks, {
        type: mime
      });
      const url = URL.createObjectURL(finalBlob);
      const pitch = _previousPitch || 0;
      const pitchSign = pitch >= 0 ? `+${pitch}` : pitch;
      const profile = _previousSoundProfile || "proNatural";
      let fileName = `${coverTitle}_Pitch${pitchSign}_${profile}_${qualityLevel.toUpperCase()}_SmartCover`;
      fileName += isMP3 ? '_Audio.webm' : '.webm';
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      createToast(`Completed successfully ${isMP3 ? '🎧 (Audio)' : '🎤🔥'}`, "success");
      activeVideo.currentTime = savedCurrentTime;
    } catch (err) {
      console.error("Cover error:", err);
      createToast("Cover failed! Check console.", "error");
    } finally {
      // 🛡️ BẢO VỆ TUYỆT ĐỐI (ANTI-MEMORY-LEAK): Gỡ bỏ triệt để các sự kiện, dọn sạch RAM ma
      if (activeVideo && stopRecording) {
        activeVideo.removeEventListener('pause', stopRecording);
        activeVideo.removeEventListener('seeking', stopRecording);
        activeVideo.removeEventListener('ended', stopRecording);
      }
      if (progressInterval) clearInterval(progressInterval);
      if (sarInterval) clearInterval(sarInterval);
      loadSensor?.stop();
      if (videoStream) videoStream.getTracks().forEach(t => t.stop());
      if (audioDestination && _jungle && _jungle.output) {
        try {
          _jungle.output.disconnect(audioDestination);
        } catch (e) {}
      }
      currentMediaRecorder = null;
      currentRecordingVideoId = null;
      isCovering = false; // Trả cờ khóa về trạng thái an toàn
    }
  }
  // =========================
  // TOAST NOTIFICATIONS (Giữ nguyên giao diện đẹp mắt của bạn)
  // =========================
  function createToast(message, type = "info") {
    let toast = document.getElementById("pitch-shifter-toast");
    if (currentMediaRecorder?.state === "recording" && toast) {
      const msgEl = toast.querySelector('.toast-message');
      if (msgEl) msgEl.textContent = message;
      toast.style.opacity = "1";
      return toast;
    }
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.id = "pitch-shifter-toast";
    toast.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    color:white;padding:14px 24px;border-radius:50px;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:999999;
    font-size:16px;font-weight:600;text-align:center;
    min-width:300px;max-width:90%;transition:all 0.4s ease;
    display:flex;flex-direction:column;gap:8px;align-items:center;
  `;
    toast.style.background = (type === "recording" || type === "success") ? "linear-gradient(135deg,#9c27b0,#e91e63)" : type === "error" ? "#f44336" : "#2196f3";
    const messageDiv = document.createElement("div");
    messageDiv.className = "toast-message";
    messageDiv.style.lineHeight = "1.4";
    messageDiv.textContent = message;
    toast.appendChild(messageDiv);
    if (type === "recording") {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;width:100%;gap:3px;";
      const progressCont = document.createElement("div");
      progressCont.style.cssText = "flex:1;height:6px;background:rgba(255,255,255,0.25);border-radius:3px;overflow:hidden;";
      const progressBar = document.createElement("div");
      progressBar.id = "toast-progress-bar";
      progressBar.style.cssText = "height:100%;width:0%;background:white;transition:width 0.3s ease;";
      progressCont.appendChild(progressBar);
      const stopWrapper = document.createElement("div");
      stopWrapper.style.position = "relative";
      const stopBtn = document.createElement("button");
      stopBtn.textContent = "■";
      stopBtn.style.cssText = `
      width:20px;height:20px;background:rgba(255,255,255,0.3);border:none;
      border-radius:50%;color:white;font-size:12px;font-weight:bold;
      cursor:pointer;transition:all 0.3s;display:flex;align-items:center;justify-content:center;
    `;
      stopBtn.onmouseover = () => {
        stopBtn.style.background = "rgba(255,255,255,0.6)";
        stopBtn.style.transform = "scale(1.15)";
        if (!document.getElementById("stop-tooltip")) {
          const tip = document.createElement("div");
          tip.id = "stop-tooltip";
          tip.textContent = "Stop recording";
          tip.style.cssText = `
          position:absolute;bottom:28px;left:50%;transform:translateX(-50%);
          background:rgba(0,0,0,0.85);color:white;padding:4px 8px;
          border-radius:6px;font-size:12px;white-space:nowrap;z-index:1000000;
        `;
          stopWrapper.appendChild(tip);
        }
      };
      stopBtn.onmouseout = () => {
        stopBtn.style.background = "rgba(255,255,255,0.3)";
        stopBtn.style.transform = "scale(1)";
        document.getElementById("stop-tooltip")?.remove();
      };
      stopBtn.onclick = () => currentMediaRecorder?.stop();
      stopWrapper.appendChild(stopBtn);
      row.appendChild(progressCont);
      row.appendChild(stopWrapper);
      toast.appendChild(row);
    }
    document.body.appendChild(toast);
    toast.style.opacity = "1";
    if (type !== "recording") {
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(-50%) translateY(20px) scale(0.95)";
        setTimeout(() => toast.remove(), 500);
      }, 2000);
    }
  }

  function updateToastProgress(percent) {
    const bar = document.getElementById("toast-progress-bar");
    if (bar) bar.style.width = `${percent}%`;
  }

  function simulateUserInteraction() {
    try {
      const now = Date.now();
      if (now - _lastInteractionTime < NONSTOP_COOLDOWN) return;
      _lastInteractionTime = now;
      if (window.location.href.includes('/shorts/')) return;
      // DI CHUỘT: Giữ nguyên, cái này rất an toàn
      const eventMouse = new MouseEvent('mousemove', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: Math.random() * 20,
        clientY: Math.random() * 20
      });
      document.body.dispatchEvent(eventMouse);
      // --- XÓA ĐOẠN CUỘN TRANG (SCROLLBY) Ở ĐÂY ---
      // Không cuộn trang nữa, không cho nó cơ hội pause video
    } catch (error) {
      // Silent fail
    }
  }

  function startSimulation() {
    if (isCovering) return;
    if (_simulateInterval) clearTimeout(_simulateInterval);
    const baseFrequency = 210000;

    function loop() {
      simulateUserInteraction();
      // Tính delay mới cho mỗi lần chạy
      const nextDelay = baseFrequency * (0.9 + Math.random() * 0.2);
      _simulateInterval = setTimeout(loop, nextDelay);
    }
    // Kích hoạt
    const initialDelay = baseFrequency * (0.9 + Math.random() * 0.2);
    _simulateInterval = setTimeout(loop, initialDelay);
  }

  function stopSimulation() {
    if (_simulateInterval) {
      clearTimeout(_simulateInterval);
      _simulateInterval = null;
    }
  }

  function updateInteraction() {
    _lastInteractionTime = Date.now();
    manageNonstopInterval();
  }

  function manageNonstopInterval() {
    if (_nonstopInterval) {
      clearInterval(_nonstopInterval);
    }
    let isPlaying = false;
    document.querySelectorAll("video").forEach(video => {
      if (isVideoPlaying(video)) {
        isPlaying = true;
      }
    });
    if (isPlaying) {
      _nonstopInterval = setInterval(() => {
        simulateUserInteraction();
      }, NONSTOP_INTERACTION_INTERVAL); // Chạy chuẩn chu kỳ 3 phút phẳng
      console.log("Nonstop interval started with 3 minutes frequency");
    }
  }
  // =========================================================================
  // CÁC HÀM HỖ TRỢ TOÀN CỤC (Khởi tạo 1 lần, cứu RAM và CPU tuyệt đối)
  // =========================================================================
  function safeStringify(obj) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      }, 2);
    } catch (e) {
      return 'Error serializing object';
    }
  }

  function simpleHash(obj) {
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) & 0xFFFFFFFF;
    }
    return hash.toString(36);
  }
  // Sửa lỗi chí mạng: Thêm bọc kiểm tra typeof để vĩnh viễn không bị văng lỗi gãy mạch
  function isContextValid() {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
  }

  function isExtensionValid() {
    return typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getManifest === "function" && !!chrome.runtime.getManifest();
  }
  // =========================================================================
  // HÀM XỬ LÝ LỖI TẬP TRUNG (Đã tối ưu hóa tốc độ phản hồi)
  // =========================================================================
  function handleError(errorMessage, error, context = {}, severity = 'medium', options = {}) {
    const isDebug = window.location.hostname === 'localhost' || window.location.search.includes('debug=true');
    // Xử lý error message chuẩn xác qua hàm helper toàn cục
    const errorMsg = error?.message || (error ? safeStringify(error) : "Không thể thực hiện thao tác");
    const errorStack = error instanceof Error ? error.stack || "No stack available" : "No stack available";
    // 🪐 ĐỒNG BỘ 1: Khóa cứng nhãn profile dự phòng về proNatural khi ghi log lỗi
    const currentProfile = options.profile || context.profile || 'proNatural';
    // Tạo error details ổn định
    const errorDetails = {
      message: errorMessage,
      error: errorMsg,
      stack: errorStack,
      context,
      severity,
      timestamp: Date.now(),
      profile: currentProfile,
      memoryManager: options.memoryManager ? 'available' : 'unavailable'
    };
    // Hệ thống Log thông minh
    if (isDebug) {
      console.error(`${errorMessage}: ${errorMsg}`, errorDetails);
    } else {
      console.error(`${errorMessage}: ${errorMsg}`);
    }
    // Lưu lỗi vào MemoryManager nếu được cấu hình
    if (options.memoryManager && typeof options.memoryManager.set === 'function') {
      try {
        const errorKey = `error_${simpleHash(errorDetails)}`;
        options.memoryManager.set(errorKey, errorDetails, 'low', {
          timestamp: Date.now(),
          expiry: Date.now() + 60000 // Lưu lỗi trong 1 phút
        });
        if (isDebug) console.debug(`Stored error for key: ${errorKey}`, errorDetails);
      } catch (storeError) {
        console.error('Failed to store error in MemoryManager', storeError);
      }
    }
    // Gửi gói tin cập nhật trạng thái lỗi về nền hệ thống
    if (isExtensionValid()) {
      try {
        // 🪐 ĐỒNG BỘ 2: Định nghĩa thông điệp âm thanh mộc thuần khiết cho proNatural khi đẩy về giao diện UI
        const mimiErrorAdjust = currentProfile === 'vocal' || currentProfile === 'karaokeDynamic' ? ' (giọng cần chắc, không rung)' : currentProfile === 'bassHeavy' || currentProfile === 'rockMetal' ? ' (bass cần lan tỏa ngắt ngay)' : currentProfile === 'proNatural' ? ' (âm thanh mộc trung thực phòng thu)' : currentProfile === 'warm' ? ' (âm thanh cần mịn màng thuần khiết)' : '';
        const details = errorMsg.includes("Tab not supported") ? `Tab không được hỗ trợ${mimiErrorAdjust}` : errorMsg.includes("Extension context invalidated") ? `Extension bị vô hiệu hóa${mimiErrorAdjust}` : errorMsg.includes("AudioContext unavailable") ? `Không thể khởi tạo âm thanh${mimiErrorAdjust}` : errorMsg.includes("Jungle instance unavailable") ? `Không thể khởi tạo hiệu ứng âm thanh${mimiErrorAdjust}` : errorMsg.includes("sampleRate is not defined") ? `Không tìm thấy sampleRate, thử mặc định 48000 Hz${mimiErrorAdjust}` : `${errorMsg}${mimiErrorAdjust}`;
        chrome.runtime.sendMessage({
          type: "error",
          message: errorMessage,
          details
        }, () => {
          // Dùng đầu lọc an toàn thay vì check đè trực tiếp lên đối tượng runtime
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
            return;
          }
        });
      } catch (sendError) {
        console.error('Error sending runtime message', sendError);
      }
    }
  }
  // =========================================================================
  // BỘ HÀM TRUY XUẤT DỮ LIỆU Ổ ĐĨA ẢO (ĐÃ KHÓA RÒ RỈ MẠCH)
  // =========================================================================
  function getStorage(key) {
    return new Promise((resolve, reject) => {
      if (!isExtensionValid()) {
        reject(new Error("Extension context invalidated"));
        return; // 🚀 CHỐNG RÒ RỈ: Ngăn chặn tuyệt đối không cho chạy xuống lệnh chrome.storage khi ngữ cảnh đã chết
      }
      try {
        chrome.storage.local.get([key], (result) => {
          // Sử dụng đầu lọc an toàn bảo vệ tầng callback
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result ? result[key] : undefined);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function setStorage(key, value) {
    return new Promise((resolve, reject) => {
      if (!isExtensionValid()) {
        reject(new Error("Extension context invalidated"));
        return; // 🚀 CHỐNG RÒ RỈ: Khóa mạch lập tức bảo vệ an toàn cho luồng JavaScript chính
      }
      try {
        chrome.storage.local.set({
          [key]: value
        }, () => {
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  // =========================================================================
  // CÔNG NGHỆ BÓC TÁCH URL CHUẨN PHẦN CỨNG (ANTI-PAUSE-LOOP)
  // =========================================================================
  function getRealVideoUrl() {
    try {
      // Sử dụng bộ dựng URL gốc của trình duyệt (URL API) để bóc tách khoa học
      const currentUrl = new URL(window.location.href);
      const videoId = currentUrl.searchParams.get("v");
      // Dù biến v nằm ở bất kỳ vị trí nào (đầu, giữa, cuối) đều bị tóm gọn chuẩn xác 100%
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    } catch (e) {
      // Silent fail, lùi về mạch dự phòng nếu URL lỗi định dạng
    }
    // Mạch dự phòng (Fallback) giữ nguyên Regex cũ của bạn để đảm bảo tính liên kết với các link cấu trúc lạ
    const urlStr = window.location.href;
    const match = urlStr.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&]+)/);
    return match ? `https://www.youtube.com/watch?v=${match[1]}` : urlStr;
  }
  // =========================================================================
  // 1. KHỞI TẠO: TỐI ƯU TẦN SỐ PHẦN CỨNG (NATIVE SAMPLE RATE)
  // =========================================================================
  function getAudioContext() {
    if (!_audioCtx || _audioCtx.state === "closed") {
      try {
        // Tự động kết nối thẳng với tần số gốc của phần cứng (Hardware Native)
        _audioCtx = new(window.AudioContext || window.webkitAudioContext)({
          latencyHint: "playback"
        });
        if (!_analyser) {
          _analyser = _audioCtx.createAnalyser();
          _analyser.fftSize = 2048;
        }
        console.log(`%c[Jungle Audio] AudioContext created safely matching hardware native: ${_audioCtx.sampleRate} Hz`, "color:lime;font-weight:bold");
      } catch (error) {
        try {
          _audioCtx = new(window.AudioContext || window.webkitAudioContext)();
          _analyser = _audioCtx.createAnalyser();
          _analyser.fftSize = 2048;
          console.warn("[Jungle Audio] Falling back to default AudioContext configuration");
        } catch (fallbackError) {
          handleError("Fatal error creating AudioContext:", fallbackError);
          return null;
        }
      }
    }
    return _audioCtx;
  }
  // =========================================================================
  // ĐỘNG CƠ AN TOÀN: ĐẢM BẢO AUDIO CONTEXT LUÔN CHẠY (BẢN CHỐNG SỰ KIỆN GIẢ LẬP TỪ SCRIPT)
  // =========================================================================
  let _resumePromise = null;

  async function ensureAudioContext() {
    const audioCtx = getAudioContext();
    if (!audioCtx) throw new Error("AudioContext unavailable");

    // 1. Nếu đã chạy ngon lành rồi thì trả về luôn
    if (audioCtx.state === "running") return audioCtx;

    // 2. Nếu có sẵn một tương tác vật lý hiện hành, thử khôi phục ngay lập tức
    if (navigator.userActivation?.isActive || document.userActivation?.isActive) {
      try {
        if (audioCtx.state === "suspended") {
          await audioCtx.resume().catch(() => {});
          if (audioCtx.state === "running") {
            console.log("[AudioEngine] Kích hoạt tức thì theo click hiện hành!");
            return audioCtx;
          }
        }
      } catch (e) {
        /* Im lặng */
      }
    }

    // 3. Nếu đang có một luồng chờ click, ép luồng gọi sau phải ĐỢI CHUNG
    if (_resumePromise) return _resumePromise;

    _resumePromise = new Promise((resolve) => {
      const resumeHandler = async (e) => {
        // 🛡️ LỚP GIÁP BẢO MẬT: Chặn đứng toàn bộ sự kiện giả lập (Untrusted Events)
        // Nếu e.isTrusted === false (do Engine 3 tự dispatch phím Space ảo), lập tức thoát ra,
        // giữ nguyên lưới lọc để chờ đợi cú click chuột THẬT sự của người dùng!
        if (e && typeof e.isTrusted === 'boolean' && !e.isTrusted) {
          return;
        }

        try {
          if (audioCtx.state === "suspended") {
            await audioCtx.resume();
            console.log(`%c[AudioEngine] Đã đánh thức mạch âm thanh mượt mà qua tương tác THẬT: ${e.type}`, "color:cyan;font-weight:bold");
          }
        } catch (err) {
          console.warn("[AudioEngine] Trình duyệt từ chối resume, tiếp tục giữ lưới đợi click tiếp theo.");
          return; // Nếu lỗi ngoài ý muốn, không tháo lưới, chờ tương tác sau
        }

        // Đã kích hoạt THÀNH CÔNG qua người dùng thật -> Tiến hành tháo gỡ dọn dẹp cổng nghe
        ['click', 'touchstart', 'keydown'].forEach(ev => document.removeEventListener(ev, resumeHandler));
        _resumePromise = null; // Giải phóng chuỗi bộ nhớ
        resolve(audioCtx);
      };

      // 🛑 CHÚ Ý: Bỏ hoàn toàn '{ once: true }' để tránh bị sự kiện ảo của script làm rách lưới nghe trước khi user chạm tay vào
      ['click', 'touchstart', 'keydown'].forEach(ev => {
        document.addEventListener(ev, resumeHandler);
      });
    });

    return _resumePromise;
  }
  // =========================================================================
  // 3. BỘ KHỞI TẠO HIỆU ỨNG JUNGLE (AN TOÀN)
  // =========================================================================
  function getJungle() {
    if (!_jungle && typeof Jungle !== "undefined") {
      const audioCtx = getAudioContext();
      if (!audioCtx) return null;
      try {
        if (!_analyser) {
          _analyser = audioCtx.createAnalyser();
        }
        _jungle = new Jungle(audioCtx);
        _jungle.output.connect(_analyser);
        _analyser.connect(audioCtx.destination);
        console.log("Jungle instance created safely");
      } catch (error) {
        handleError("Error creating Jungle instance:", error);
        return null;
      }
    }
    return _jungle;
  }
  // =========================================================================
  // CẦU NỐI CHIA SẺ ANALYSER: cho phép bảng Equalizer/AI (initAjuUiInteractions,
  // định nghĩa ở scope riêng bên ngoài IIFE này) đọc dữ liệu phổ tần THẬT từ
  // đúng analyser của engine pitch chính, thay vì tự tạo AudioContext +
  // createMediaElementSource thứ 2 trên cùng 1 <video> (việc này luôn ném
  // InvalidStateError vì 1 <video> chỉ được gắn 1 MediaElementAudioSourceNode).
  // =========================================================================
  window.__getSharedFrequencyBins = function() {
    try {
      if (!_analyser) return null;
      const bins = new Uint8Array(_analyser.frequencyBinCount);
      _analyser.getByteFrequencyData(bins);
      return bins;
    } catch (e) {
      return null;
    }
  };
  window.__resumeSharedAudioContext = function() {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    } catch (e) {}
  };
  // =========================================================================
  // 4. TRỤC KẾT NỐI VẬT LÝ: LẤY NODE ĐẦU RA (BẢN GỐC ỔN ĐỊNH CỦA BẠN)
  // =========================================================================
  async function getOutputNode(video) {
    if (!outputNodeMap.has(video)) {
      const audioCtx = getAudioContext();
      if (!audioCtx) return null;
      try {
        await ensureAudioContext(); // <-- Sẽ đợi chuẩn chỉ cho đến khi mạch thực sự ON
      } catch (error) {
        console.error("Failed to ensure AudioContext:", error.message);
        return null;
      }
      let retryCount = 0;
      const maxRetries = 3;
      while (retryCount < maxRetries) {
        try {
          const outputNode = {
            outputNode: audioCtx.createMediaElementSource(video),
            destinationConnected: false,
            pitchShifterConnected: false,
          };
          outputNodeMap.set(video, outputNode);
          console.log("Output node created for video");
          return outputNode;
        } catch (error) {
          if (error.name === 'InvalidStateError' && error.message.includes('already connected previously')) {
            const currentTime = video.currentTime;
            const wasPlaying = !video.paused && !video.ended && video.readyState > 2;
            video.pause();
            const originalSrc = video.src || video.currentSrc;
            video.src = '';
            video.load();
            await new Promise(resolve => {
              const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                resolve();
              };
              video.addEventListener('canplay', onCanPlay, {
                once: true
              });
            });
            video.src = originalSrc;
            video.currentTime = currentTime;
            if (wasPlaying) {
              await video.play().catch(err => handleError("Silent error resuming video after reset:", err));
            }
            retryCount++;
          } else {
            console.error("Error creating output node:", error.message);
            return null;
          }
        }
      }
      console.error("Max retries reached for output node creation.");
      return null;
    }
    return outputNodeMap.get(video);
  }
  async function calculateBPM() {
    if (isCalculatingBPM) {
      console.log("BPM calculation in progress, please wait.");
      return {
        bpm: _currentBPM || null,
        key: _currentKey || null,
        error: "Calculation in progress",
        confidence: 0
      };
    }
    if (!outputNodeMap || !isVideoPlaying || !getRealVideoUrl) {
      console.warn("Missing dependencies:", {
        outputNodeMap: !!outputNodeMap,
        isVideoPlaying: !!isVideoPlaying,
        getRealVideoUrl: !!getRealVideoUrl
      });
      return {
        bpm: null,
        key: null,
        error: "System dependencies missing",
        confidence: 0
      };
    }
    let activeVideo = Array.from(outputNodeMap.keys()).find(v => isVideoPlaying(v));
    if (!activeVideo || !videoConnected || !_analyser || !_audioCtx) {
      console.log("No active video or analyser not ready, attempting to connect...");
      let foundVideo = null;
      document.querySelectorAll("video").forEach(video => {
        if (isVideoPlaying(video) && !outputNodeMap.has(video)) {
          foundVideo = video;
        }
      });
      if (foundVideo) {
        await connectVideo(foundVideo);
        activeVideo = foundVideo;
        console.log("Connected new video for BPM calculation:", getRealVideoUrl());
      }
    }
    if (!activeVideo || !videoConnected || !_analyser || !_audioCtx) {
      console.warn("Unable to calculate BPM:", {
        hasVideo: !!activeVideo,
        videoConnected,
        hasAnalyser: !!_analyser,
        hasAudioCtx: !!_audioCtx
      });
      return {
        bpm: null,
        key: null,
        error: "No active video or analyser not ready",
        confidence: 0
      };
    }
    const realUrl = getRealVideoUrl();
    let cachedResult;
    try {
      cachedResult = await getStorage(`bpm_key_${realUrl}`);
      if (cachedResult && cachedResult.bpm && cachedResult.key && cachedResult.confidence > 0.97) {
        console.log("Using cached BPM and Key:", cachedResult);
        _currentBPM = cachedResult.bpm;
        _currentKey = cachedResult.key;
        return {
          bpm: _currentBPM,
          key: _currentKey,
          error: null,
          confidence: cachedResult.confidence
        };
      }
    } catch (err) {
      console.warn("Error accessing cache:", err);
    }
    try {
      isCalculatingBPM = true;
      await ensureAudioContext();
      const sampleRate = _audioCtx.sampleRate;
      const bufferLength = _analyser.frequencyBinCount;
      const timeData = new Float32Array(bufferLength);
      const freqData = new Float32Array(bufferLength);
      let prevFreqData = new Float32Array(bufferLength);
      let fluxHistory = {
        low: [],
        mid: [],
        high: [],
        combined: []
      };
      let freqHistory = [];
      const maxDuration = 10000;
      const intervalCheckTime = 50;
      let elapsedTime = 0;
      let lowEnergy = 0,
        midEnergy = 0,
        highEnergy = 0;
      let frameCount = 0;
      let kalmanBPM = null;
      let kalmanVariance = 4.0;
      const processNoise = 0.002;
      const measurementNoise = 0.3;

      function updateKalmanFilter(measurement) {
        if (!isFinite(measurement)) return kalmanBPM || null;
        if (kalmanBPM === null) {
          kalmanBPM = measurement;
          return kalmanBPM;
        }
        const prediction = kalmanBPM;
        kalmanVariance += processNoise;
        const kalmanGain = kalmanVariance / (kalmanVariance + measurementNoise);
        kalmanBPM = prediction + kalmanGain * (measurement - prediction);
        kalmanVariance *= (1 - kalmanGain);
        return kalmanBPM;
      }

      function getSpectralFlux() {
        _analyser.getFloatFrequencyData(freqData);
        let flux = {
          low: 0,
          mid: 0,
          high: 0,
          combined: 0
        };
        const bandSize = bufferLength / 8;
        const totalEnergy = lowEnergy + midEnergy + highEnergy || 1;
        const isBassHeavy = lowEnergy / totalEnergy > 0.5;
        for (let i = 0; i < bandSize; i++) {
          const freq = i * (sampleRate / _analyser.fftSize);
          const diff = Math.max(freqData[i] - prevFreqData[i], 0);
          const weight = diff * diff * (freq >= 200 && freq <= 2000 ? 0.9 : isBassHeavy && freq < 200 ? 1.7 : 1.0);
          if (i < bandSize / 3) {
            flux.low += weight;
            lowEnergy += Math.abs(freqData[i]);
          } else if (i < (2 * bandSize) / 3) {
            flux.mid += weight * 1.0;
            midEnergy += Math.abs(freqData[i]);
          } else {
            flux.high += weight;
            highEnergy += Math.abs(freqData[i]);
          }
          flux.combined += weight;
        }
        frameCount++;
        prevFreqData.set(freqData);
        const smoothingFactor = midEnergy > lowEnergy && midEnergy > highEnergy ? 0.2 : 0.4;
        fluxHistory.low.push(Math.sqrt(flux.low) * smoothingFactor + (fluxHistory.low.at(-1) || 0) * (1 - smoothingFactor));
        fluxHistory.mid.push(Math.sqrt(flux.mid) * smoothingFactor + (fluxHistory.mid.at(-1) || 0) * (1 - smoothingFactor));
        fluxHistory.high.push(Math.sqrt(flux.high) * smoothingFactor + (fluxHistory.high.at(-1) || 0) * (1 - smoothingFactor));
        fluxHistory.combined.push(Math.sqrt(flux.combined) * smoothingFactor + (fluxHistory.combined.at(-1) || 0) * (1 - smoothingFactor));
        if (freqHistory.length < 100) {
          freqHistory.push(freqData.slice(0, bandSize));
        }
        return flux.combined;
      }
      const collectData = () => new Promise((resolve) => {
        const checkBPM = async () => {
          if (!isVideoPlaying(activeVideo)) {
            resolve({
              bpm: null,
              key: null,
              error: "Video stopped during analysis",
              confidence: 0
            });
            return;
          }
          if (document.querySelector('.ytp-ad-player-overlay, .ytp-ad-skip-button')) {
            resolve({
              bpm: null,
              key: null,
              error: "Advertisement detected",
              confidence: 0
            });
            return;
          }
          if (activeVideo.currentTime < 10 || (activeVideo.duration && activeVideo.currentTime > activeVideo.duration - 10)) {
            resolve({
              bpm: null,
              key: null,
              error: "Skipping intro or outro",
              confidence: 0
            });
            return;
          }
          if (_audioCtx.state === "suspended") {
            await _audioCtx.resume().catch((err) => console.warn("Failed to resume AudioContext:", err));
          }
          _analyser.getFloatTimeDomainData(timeData);
          getSpectralFlux();
          elapsedTime += intervalCheckTime;
          if (elapsedTime % 1000 === 0 && isExtensionValid()) {
            chrome.runtime.sendMessage({
              type: "bpmStatus",
              message: `Analyzing (${(elapsedTime / 1000).toFixed(1)}s)...`
            });
          }
          // 🚀 SỬA LỖI CHÍ MẠNG: Chỉ chạy dự đoán sớm chuẩn chu kỳ tĩnh phẳng tròn góc 1 giây (1000ms)
          // Giảm số lần quét từ 20 lần/giây xuống còn đúng 1 lần/giây -> Cứu CPU mát rượi, vĩnh viễn hết giật video!
          if (elapsedTime >= 3000 && elapsedTime % 1000 === 0) {
            const onsets = detectOnsets(fluxHistory, intervalCheckTime, 'mid');
            const bpmFromOnsets = estimateBPMFromOnsets(onsets, 'mid');
            const confidence = calculateConfidence(bpmFromOnsets, onsets);
            if (bpmFromOnsets && confidence > 0.97) {
              const key = await detectKey(freqHistory, 'mid');
              const result = {
                bpm: updateKalmanFilter(bpmFromOnsets),
                confidence,
                key,
                error: null
              };
              console.log("Early prediction:", result);
              if (confidence > 0.97) {
                await setStorage(`bpm_key_${realUrl}`, {
                  bpm: result.bpm,
                  key: result.key,
                  confidence,
                  timestamp: Date.now()
                }).catch(err => console.warn("Error saving to cache:", err));
                resolve(result);
                return;
              }
            }
          }
          if (elapsedTime >= maxDuration) {
            const totalEnergy = lowEnergy + midEnergy + highEnergy || 1;
            const isBassHeavy = lowEnergy / totalEnergy > 0.5;
            const isBalanced = midEnergy / totalEnergy > 0.4;
            const primaryBand = isBassHeavy ? 'low' : isBalanced ? 'mid' : 'combined';
            console.debug("Audio context:", {
              isBassHeavy,
              isBalanced,
              primaryBand
            });
            const onsets = detectOnsets(fluxHistory, intervalCheckTime, primaryBand);
            let bpmFromOnsets = estimateBPMFromOnsets(onsets, primaryBand);
            const bpmFromAutocorr = autocorrelate(timeData);
            const key = await detectKey(freqHistory, primaryBand);
            let finalBPM = bpmFromOnsets;
            let confidence = calculateConfidence(bpmFromOnsets, onsets);
            if (!bpmFromOnsets || confidence < 0.97) {
              if (bpmFromAutocorr && Math.abs(bpmFromAutocorr - 133) < 10) {
                finalBPM = bpmFromAutocorr;
                confidence = 0.95;
              } else if (bpmFromAutocorr && Math.abs(bpmFromAutocorr - 106) < 10) {
                finalBPM = bpmFromAutocorr;
                confidence = 0.95;
              } else {
                finalBPM = bpmFromAutocorr || bpmFromOnsets;
                confidence = bpmFromAutocorr ? 0.9 : 0.8;
              }
            } else if (bpmFromAutocorr && Math.abs(bpmFromOnsets - bpmFromAutocorr) < 10) {
              finalBPM = (bpmFromOnsets * confidence + bpmFromAutocorr * (1 - confidence)) / 2;
              confidence *= 1.05;
            }
            if (finalBPM) {
              finalBPM = updateKalmanFilter(finalBPM);
              finalBPM = adjustBPM(finalBPM, confidence);
            }
            const pitch = parseFloat(document.getElementById('pitch')?.value) || _previousPitch || 0;
            const playbackRate = parseFloat(document.getElementById('playback-rate')?.value) || _previousPlaybackRate || 1;
            const isTranspose = document.getElementById('pitch-shift-type')?.value === 'semi-tone' || transpose || false;
            const pitchFactor = isTranspose ? Math.pow(2, Math.min(Math.max(pitch, -12), 12) / 12) : (1 + Math.min(Math.max(pitch, -0.5), 0.5));
            const adjustedPlaybackRate = Math.max(0.5, Math.min(playbackRate, 2));
            finalBPM = finalBPM ? Math.round(finalBPM / pitchFactor / adjustedPlaybackRate) : null;
            if (finalBPM && key !== "Unknown" && confidence > 0.97) {
              await setStorage(`bpm_key_${realUrl}`, {
                bpm: finalBPM,
                key,
                confidence,
                timestamp: Date.now()
              }).catch(err => console.warn("Error saving to cache:", err));
            }
            console.debug("Final BPM calculation:", {
              finalBPM,
              bpmFromOnsets,
              bpmFromAutocorr,
              confidence,
              key,
              primaryBand
            });
            resolve({
              bpm: finalBPM,
              key,
              error: null,
              confidence
            });
          } else {
            setTimeout(checkBPM, intervalCheckTime);
          }
        };
        console.log("Starting BPM and Key analysis for:", realUrl);
        checkBPM();
      });
      const result = await collectData();
      const {
        bpm,
        confidence,
        key,
        error
      } = result;
      if (bpm !== null) {
        _currentBPM = bpm;
        _currentKey = key;
        if (isExtensionValid()) {
          chrome.runtime.sendMessage({
            type: "bpmUpdate",
            bpm: _currentBPM,
            key: _currentKey,
            confidence
          });
        }
        const historyEntry = {
          url: realUrl,
          bpm: _currentBPM,
          key: _currentKey,
          confidence,
          timestamp: new Date().toISOString(),
          title: document.title || "Unknown"
        };
        try {
          const history = (await getStorage("bpm_history")) || [];
          if (!Array.isArray(history)) throw new Error("Invalid BPM history");
          history.push(historyEntry);
          if (history.length > 100) {
            history.shift();
          }
          await setStorage("bpm_history", history);
          console.log("Saved to BPM history:", historyEntry);
        } catch (err) {
          console.warn("Error saving BPM history:", err);
        }
      }
      isCalculatingBPM = false;
      return {
        bpm,
        key,
        error,
        confidence
      };
    } catch (error) {
      console.error("Error calculating BPM:", error, {
        url: realUrl,
        stack: error.stack
      });
      isCalculatingBPM = false;
      return {
        bpm: null,
        key: null,
        error: error.message,
        confidence: 0
      };
    }
  }

  function detectOnsets(fluxHistory, intervalCheckTime, primaryBand) {
    try {
      if (!fluxHistory || !fluxHistory.low || !fluxHistory.mid || !fluxHistory.high || !fluxHistory.combined) {
        throw new Error("Dữ liệu fluxHistory không hợp lệ");
      }
      const bands = ['low', 'mid', 'high', 'combined'];
      const onsets = [];
      bands.forEach(band => {
        const data = fluxHistory[band];
        if (!data?.length) return;
        const smoothingFactor = band === primaryBand ? 0.2 : 0.4;
        // 🚀 CHUẨN HÓA TOÁN HỌC: Cân bằng lại tổng trọng số mảng lọc bằng 1.0 thực tế
        // Tránh việc năng lượng âm thanh bị sụt giảm tích lũy, giúp tính toán cực nhạy và ra kết quả sớm!
        const sideWeight = (1.0 - smoothingFactor) / 4;
        const smoothedData = data.map((v, i) => (i > 1 && i < data.length - 2 ? (data[i - 2] * sideWeight + data[i - 1] * (sideWeight * 2) + v * smoothingFactor + data[i + 1] * (sideWeight * 2) + data[i + 2] * sideWeight) : v));
        const differences = smoothedData.map((v, i) => i > 0 ? Math.max(v - smoothedData[i - 1], 0) : 0);
        const windowSize = 60;
        const bandWeight = band === primaryBand ? 1.0 : 1.0;
        const thresholds = differences.map((_, i) => {
          const start = Math.max(0, i - windowSize);
          const window = differences.slice(start, i + windowSize + 1);
          const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
          const std = Math.sqrt(window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length) || 1;
          return (mean + 1.0 * std) * bandWeight;
        });
        const minInterval = 60;
        let lastOnset = -minInterval;
        differences.forEach((diff, i) => {
          if (diff > thresholds[i] && (i * intervalCheckTime - lastOnset) >= minInterval) {
            onsets.push({
              time: i * intervalCheckTime,
              strength: diff,
              band
            });
            lastOnset = i * intervalCheckTime;
          }
        });
      });
      return onsets.sort((a, b) => a.time - b.time).filter((onset, i, arr) => {
        const next = arr[i + 1];
        return !next || Math.abs(next.time - onset.time) > 10;
      }).map(o => o.time);
    } catch (err) {
      console.error("Lỗi detectOnsets:", err);
      return [];
    }
  }

  function estimateBPMFromOnsets(onsets, primaryBand) {
    try {
      if (!onsets?.length || onsets.length < 10) return null;
      const intervals = onsets.slice(1).map((v, i) => v - onsets[i]);
      const minBPM = 50;
      const maxBPM = 200;
      // 🚀 CẢI TIẾN CHÍ MẠNG: Đưa bước nhảy về 0.1 để các giá trị BPM gần nhau gom được vào cùng một giỏ
      // Việc này giúp Histogram hoạt động đúng bản chất, tìm ra đỉnh nhịp chính xác lập tức!
      const bpmStep = 0.1;
      const histogram = new Map();
      intervals.forEach(interval => {
        const bpm = 60000 / interval;
        if (bpm >= minBPM && bpm <= maxBPM) {
          // Làm tròn đến 1 chữ số thập phân để làm sạch khóa Map
          const roundedBPM = Math.round(bpm / bpmStep) * bpmStep;
          const key = Math.round(roundedBPM * 10) / 10;
          histogram.set(key, (histogram.get(key) || 0) + 1);
        }
      });
      let bestBPM = null,
        bestScore = 0;
      for (const [bpm, count] of histogram) {
        let score = count;
        if (bpm >= 80 && bpm <= 140) score *= 2.5;
        if (primaryBand === 'mid' && bpm >= 100 && bpm <= 140) score *= 1.1;
        if (primaryBand === 'low' && bpm > 100) score *= 1.0;
        if (primaryBand === 'high' && bpm < 120) score *= 1.0;
        if (score > bestScore) {
          bestScore = score;
          bestBPM = bpm;
        }
      }
      if (bestBPM) {
        const candidates = [bestBPM, bestBPM * 2, bestBPM / 2].filter(bpm => bpm >= minBPM && bpm <= maxBPM);
        bestScore = 0;
        candidates.forEach(bpm => {
          let score = 0;
          intervals.forEach(interval => {
            const expectedInterval = 60000 / bpm;
            const ratio = interval / expectedInterval;
            const error = Math.min(Math.abs(ratio - 1), Math.abs(ratio - 0.5), Math.abs(ratio - 2));
            if (error < 0.01) score += 1;
          });
          if (score > bestScore) {
            bestScore = score;
            bestBPM = bpm;
          }
        });
        // 🚀 KHAI THÔNG MẠCH PHẲNG: Lúc này các ô lân cận đã có dữ liệu thực, công thức Parabolic sẽ bóp nhỏ sai số về mức lý tưởng
        if (bestBPM && histogram.size > 0) {
          const targetKey = Math.round(bestBPM * 10) / 10;
          const prevKey = Math.round((bestBPM - bpmStep) * 10) / 10;
          const nextKey = Math.round((bestBPM + bpmStep) * 10) / 10;
          const prev = histogram.get(prevKey) || 0;
          const curr = histogram.get(targetKey) || 0;
          const next = histogram.get(nextKey) || 0;
          if (prev + curr + next > 0) {
            const delta = 0.5 * (prev - next) / (prev - 2 * curr + next || 1);
            bestBPM += delta * bpmStep;
          }
        }
      }
      return bestBPM;
    } catch (err) {
      console.error("Error in estimateBPMFromOnsets:", err);
      return null;
    }
  }

  function autocorrelate(data) {
    try {
      if (!data?.length) throw new Error("Dữ liệu timeData không hợp lệ");
      const sampleRate = _audioCtx?.sampleRate || 48000;
      let minLag = Math.floor(sampleRate / 240);
      let maxLag = Math.floor(sampleRate / 40);
      if (typeof devicePerf !== 'undefined' && devicePerf < 0.5) {
        minLag = Math.floor(minLag * 1.2);
        maxLag = Math.floor(maxLag * 0.8);
      }
      const mean = data.reduce((s, v) => s + v, 0) / data.length;
      const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length;
      const std = Math.sqrt(variance) || 1;
      if (std < 0.02) {
        console.debug("autocorrelate: Signal cực yếu (std < 0.02), bỏ qua fallback", {
          std: std.toFixed(5)
        });
        return null;
      }
      const normalized = data.map(v => (v - mean) / std);
      const N = normalized.length;
      const windowed = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const t = 2 * Math.PI * i / (N - 1);
        const w = 0.5 - 0.5 * Math.cos(t);
        windowed[i] = normalized[i] * w;
      }
      const filtered = new Float32Array(N);
      filtered[0] = windowed[0];
      filtered[N - 1] = windowed[N - 1];
      for (let i = 1; i < N - 1; i++) {
        filtered[i] = (windowed[i - 1] + windowed[i] + windowed[i + 1]) / 3;
      }
      let bestLag = 0;
      let maxCorr = 0;
      const adaptiveThresh = Math.max(0.005, 0.03 * (0.5 + std * 0.8));
      for (let lag = minLag; lag < maxLag; lag++) {
        let sum = 0;
        const len = N - lag;
        for (let i = 0; i < len; i++) sum += filtered[i] * filtered[i + lag];
        const corr = sum / len;
        if (corr > maxCorr && corr > adaptiveThresh) {
          maxCorr = corr;
          bestLag = lag;
        }
      }
      if (bestLag > minLag && bestLag < maxLag - 1 && maxCorr > adaptiveThresh) {
        const prev = computeCorr(bestLag - 1);
        const curr = maxCorr;
        const next = computeCorr(bestLag + 1);
        const delta = 0.5 * (prev - next) / (prev - 2 * curr + next || 1);
        bestLag += delta;
      }
      if (bestLag && maxCorr > adaptiveThresh) {
        const bpm = (sampleRate / bestLag) * 60;
        const rounded = Math.round(bpm * 10) / 10;
        console.debug("autocorrelate: Phát hiện BPM cực chuẩn", {
          bpm: rounded,
          lag: bestLag.toFixed(2),
          corr: maxCorr.toFixed(4),
          thresh: adaptiveThresh.toFixed(4),
          std: std.toFixed(4)
        });
        return rounded;
      }
      if (std > 0.05) {
        const fallbackBPM = 90;
        console.info("autocorrelate: Nhịp yếu nhưng vẫn đủ dữ liệu → dùng fallback thông minh BPM =", fallbackBPM, {
          std: std.toFixed(4),
          maxCorr: maxCorr.toFixed(4),
          thresh: adaptiveThresh.toFixed(4)
        });
        return fallbackBPM;
      }
      console.debug("autocorrelate: Không đủ dữ liệu nhịp → trả null để ưu tiên onset detection", {
        std: std.toFixed(4),
        maxCorr: maxCorr.toFixed(4)
      });
      return null;

      function computeCorr(lag) {
        if (lag < minLag || lag >= maxLag) return 0;
        let sum = 0;
        const len = N - lag;
        for (let i = 0; i < len; i++) sum += filtered[i] * filtered[i + lag];
        return sum / len;
      }
    } catch (err) {
      console.error("Lỗi autocorrelate:", err.message || err);
      return null;
    }
  }

  function adjustBPM(bpm, confidence) {
    try {
      if (!isFinite(bpm)) return null;
      let adjustedBPM = bpm;
      while (adjustedBPM > 200 && confidence < 0.95) adjustedBPM /= 2;
      while (adjustedBPM < 50) adjustedBPM *= 2;
      return Math.round(adjustedBPM);
    } catch (err) {
      console.error("Lỗi adjustBPM:", err);
      return null;
    }
  }

  function calculateConfidence(bpm, onsets) {
    try {
      if (!isFinite(bpm) || !onsets?.length || onsets.length < 10) return 0.8;
      const expectedInterval = 60000 / bpm;
      const intervals = onsets.slice(1).map((v, i) => v - onsets[i]);
      let consistency = 0;
      let totalEnergy = 0;
      intervals.forEach(interval => {
        const ratio = interval / expectedInterval;
        const error = Math.min(Math.abs(ratio - 1), Math.abs(ratio - 0.5), Math.abs(ratio - 2));
        if (error < 0.01) consistency++;
        totalEnergy += interval;
      });
      const stability = intervals.length > 0 ? consistency / intervals.length : 0;
      const energyScore = intervals.length > 0 ? Math.min(1, totalEnergy / (expectedInterval * intervals.length)) : 0;
      const bpmRangeScore = bpm >= 80 && bpm <= 140 ? 0.55 : 0;
      const confidence = Math.min(0.98, Math.max(0.8, (stability * 0.5 + energyScore * 0.2 + bpmRangeScore * 0.3)));
      return isNaN(confidence) ? 0.8 : confidence;
    } catch (err) {
      console.error("Lỗi calculateConfidence:", err);
      return 0.8;
    }
  }
  async function detectKey(freqHistory, primaryBand = 'mid') {
    try {
      if (freqHistory.length < 100 || !_analyser || !_audioCtx) {
        console.warn("detectKey: Insufficient data or invalid context", {
          freqHistoryLength: freqHistory.length,
          hasAnalyser: !!_analyser,
          hasAudioCtx: !!_audioCtx
        });
        const cachedResult = await getStorage(`bpm_key_${getRealVideoUrl()}`);
        if (cachedResult?.key && cachedResult.confidence > 0.97) {
          console.log("detectKey: Using cached key:", cachedResult.key);
          return cachedResult.key;
        }
        return _currentKey || "Unknown";
      }
      const chroma = new Float32Array(12).fill(0);
      const freqResolution = _audioCtx.sampleRate / (_analyser.fftSize * 2);
      const bandSize = Math.min(_analyser.frequencyBinCount / 8, 128);
      const recentFrames = freqHistory.slice(-100);
      if (!recentFrames.length) {
        console.warn("detectKey: No frequency frames available");
        return _currentKey || "Unknown";
      }
      let lowFreqEnergy = 0,
        midFreqEnergy = 0,
        highFreqEnergy = 0;
      recentFrames.forEach(frame => {
        for (let i = 0; i < bandSize; i++) {
          const freq = i * freqResolution;
          if (freq < 200) lowFreqEnergy += Math.abs(frame[i]);
          else if (freq <= 2000) midFreqEnergy += Math.abs(frame[i]);
          else highFreqEnergy += Math.abs(frame[i]);
        }
      });
      const totalEnergy = lowFreqEnergy + midFreqEnergy + highFreqEnergy || 1;
      const midWeight = (midFreqEnergy / totalEnergy > 0.5) ? 0.7 : 0.9;
      recentFrames.forEach(frame => {
        for (let i = 0; i < bandSize; i++) {
          const freq = i * freqResolution;
          if (freq < 100 || freq > 6000) continue;
          const noteIndex = Math.round(12 * Math.log2(freq / 440) + 69) % 12;
          const baseWeight = Math.abs(frame[i]);
          // 🚀 CHUẨN HÓA HOẠ HÂM: Sử dụng Math.abs toán học khoảng cách đối xứng để tóm gọn cả lệch trái và lệch phải.
          // Rút gọn từ 5 lệnh chia xuống còn 1 phép chia duy nhất cho mỗi vòng lặp -> Tốc độ xử lý tăng vọt!
          const remainder = freq % 55;
          const dist = Math.min(remainder, 55 - remainder);
          const harmonicFactor = (dist < 10 || freq % 440 < 10 || 440 - (freq % 440) < 10) ? 1.4 : 1.0;
          const weight = baseWeight * (freq >= 200 && freq <= 2000 ? midWeight : 1.0) * harmonicFactor;
          chroma[noteIndex] += weight * (1 - Math.abs(freq - 600) / 6000);
        }
      });
      const smoothedChroma = new Float32Array(12);
      const smoothingFactor = primaryBand === 'mid' ? 0.4 : 0.3;
      for (let i = 0; i < 12; i++) {
        smoothedChroma[i] = (chroma[i] * smoothingFactor + chroma[(i + 11) % 12] * ((1 - smoothingFactor) / 2) + chroma[(i + 1) % 12] * ((1 - smoothingFactor) / 2));
      }
      const maxChroma = Math.max(...smoothedChroma);
      if (maxChroma < 0.3) {
        console.warn("detectKey: Chroma signal too weak", {
          maxChroma,
          primaryBand
        });
        const cached = await getStorage(`bpm_key_${getRealVideoUrl()}`);
        if (cached?.key && cached.confidence > 0.9) {
          console.log("detectKey: Using cached key (weak signal)", cached.key);
          return cached.key;
        }
        return primaryBand === 'low' ? "C Minor" : primaryBand === 'high' ? "C Major" : _currentKey || "C Major";
      }
      const normalizedChroma = smoothedChroma.map(v => v / maxChroma);
      const sumNormalized = normalizedChroma.reduce((sum, v) => sum + v, 0) || 1;
      const profileChroma = normalizedChroma.map(v => v / sumNormalized);
      const krumhanslMajor = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88].map(v => v / 43.82);
      const krumhanslMinor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17].map(v => v / 44.52);
      const temperleyMajor = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400].map(v => v / 4.246);
      const temperleyMinor = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330].map(v => v / 4.183);
      const signatureMajor = [1, 0.2, 0.8, 0.3, 0.9, 0.6, 0.4, 1, 0.3, 0.7, 0.2, 0.6].map(v => v / 6.0);
      const signatureMinor = [1, 0.2, 0.8, 0.9, 0.3, 0.6, 0.4, 1, 0.8, 0.3, 0.6, 0.2].map(v => v / 7.1);
      const templates = [{
        name: 'krumhanslMajor',
        profile: krumhanslMajor,
        isMinor: false
      }, {
        name: 'krumhanslMinor',
        profile: krumhanslMinor,
        isMinor: true
      }, {
        name: 'temperleyMajor',
        profile: temperleyMajor,
        isMinor: false
      }, {
        name: 'temperleyMinor',
        profile: temperleyMinor,
        isMinor: true
      }, {
        name: 'signatureMajor',
        profile: signatureMajor,
        isMinor: false
      }, {
        name: 'signatureMinor',
        profile: signatureMinor,
        isMinor: true
      }];

      function cosineSimilarity(a, b) {
        let dot = 0,
          normA = 0,
          normB = 0;
        for (let i = 0; i < 12; i++) {
          dot += a[i] * b[i];
          normA += a[i] ** 2;
          normB += b[i] ** 2;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB)) || 0;
      }

      function pearsonHybrid(a, b) {
        const meanA = a.reduce((sum, v) => sum + v, 0) / 12;
        const meanB = b.reduce((sum, v) => sum + v, 0) / 12;
        let num = 0,
          denA = 0,
          denB = 0;
        for (let i = 0; i < 12; i++) {
          const diffA = a[i] - meanA;
          const diffB = b[i] - meanB;
          num += diffA * diffB;
          denA += diffA ** 2;
          denB += diffB ** 2;
        }
        return num / Math.sqrt(denA * denB) || 0;
      }
      let bestScore = -Infinity,
        bestKey = 0,
        isMinor = false;
      const votes = new Map();
      templates.forEach(template => {
        for (let shift = 0; shift < 12; shift++) {
          const shifted = template.profile.map((_, i) => template.profile[(i + shift) % 12]);
          let cosScore = cosineSimilarity(profileChroma, shifted);
          let pearScore = pearsonHybrid(profileChroma, shifted);
          let score = (cosScore + pearScore) / 2;
          if (primaryBand === 'mid') score *= 1.02;
          if (primaryBand === 'low') score *= template.isMinor ? 1.2 : 1.0;
          const keyId = `${shift}_${template.isMinor ? 'Minor' : 'Major'}`;
          votes.set(keyId, (votes.get(keyId) || 0) + score);
          if (score > bestScore) {
            bestScore = score;
            bestKey = shift;
            isMinor = template.isMinor;
          }
        }
      });
      let maxVote = 0;
      let finalBestKey = bestKey;
      let finalIsMinor = isMinor;
      for (const [keyId, voteScore] of votes) {
        if (voteScore > maxVote) {
          maxVote = voteScore;
          const [shift, mode] = keyId.split('_');
          finalBestKey = parseInt(shift);
          finalIsMinor = mode === 'Minor';
        }
      }
      let adjustedKey = finalBestKey;
      const pitch = parseFloat(document.getElementById('pitch')?.value) || _previousPitch || 0;
      const isTranspose = document.getElementById('pitch-shift-type')?.value === 'semi-tone' || transpose || false;
      if (isTranspose && pitch !== 0) {
        adjustedKey = (finalBestKey + Math.round(pitch) + 12) % 12;
      } else if (pitch !== 0) {
        const pitchFactor = pitch >= 0 ? 12 * Math.log2(1 + Math.min(pitch, 0.5)) : -12 * Math.log2(1 - Math.min(-pitch, 0.5));
        adjustedKey = (finalBestKey + Math.round(pitchFactor * 0.6) + 12) % 12;
      }
      const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      const rootNote = noteNames[adjustedKey] || "C";
      const finalKey = `${rootNote} ${finalIsMinor ? "Minor" : "Major"}`;
      console.debug("detectKey: Final key calculation", {
        bestKey: finalBestKey,
        isMinor: finalIsMinor,
        adjustedKey,
        finalKey,
        pitch,
        isTranspose,
        maxChroma,
        bestScore: maxVote / templates.length
      });
      return finalKey;
    } catch (err) {
      console.error("Error in detectKey:", err, {
        stack: err.stack
      });
      return _currentKey || "Unknown";
    }
  }

  function resetToDefault() {
    // 🚨 PHANH CỨU SINH CHÍ MẠNG: Nếu người dùng đang bật chế độ HOLD (khóa cấu hình), 
    // TUYỆT ĐỐI không được reset hay nạp Fav, giữ nguyên hiện trạng âm thanh hiện tại cho bài tiếp theo!
    if (typeof isHeld !== 'undefined' && isHeld) {
      console.log("%c[Hold Mode Active] Đang khóa cấu hình -> Bỏ qua mạch reset, giữ nguyên thông số âm thanh cho bài tiếp theo!", "color:lime;font-weight:bold");
      return;
    }
    const realUrl = getRealVideoUrl();
    const favItem = favoritesMap.get(realUrl); // BƯỚC 1: Kiểm tra tiền trạm xem bài này có cấu hình Fav không
    if (favItem) {
      // [TRƯỜNG HỢP 1] BÀI HÁT TRONG FAV: Đồng bộ thẳng thông số đã lưu làm vạch xuất phát mới
      _previousPitch = parseFloat(favItem.pitch ?? 0);
      _previousPlaybackRate = parseFloat(favItem.playbackRate ?? 1);
      _previousBoost = parseFloat(favItem.boost ?? 0.8);
      _previousPan = parseFloat(favItem.pan ?? 0);
      // Chuẩn hóa tên Profile từ danh sách yêu thích
      let soundProfile = favItem.soundProfile || "proNatural";
      if (typeof soundProfile === 'string' && soundProfile.includes('-')) {
        soundProfile = soundProfile.replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      }
      _previousSoundProfile = soundProfile;
      transpose = favItem.transpose ?? true;
      console.log("%c[Smart Reset] Phát hiện bài hát trong danh sách FAV -> Đồng bộ thẳng hiện trạng thanh kéo!", "color:cyan;font-weight:bold");
    } else {
      // [TRƯỜNG HỢP 2] BÀI HÁT THƯỜNG: Trả về cấu hình phẳng mặc định sạch sẽ
      _previousPitch = 0;
      _previousPlaybackRate = 1;
      _previousBoost = 0.8;
      _previousPan = 0;
      _previousSoundProfile = "proNatural";
      transpose = true;
    }
    // Xóa trắng bộ nhớ tần số bài hát cũ
    _currentBPM = null;
    _currentKey = null;
    // BƯỚC 2: Ép thông số mục tiêu thẳng xuống phần cứng lõi DSP ngay lập tức
    const jungle = getJungle();
    if (jungle && videoConnected) {
      jungle.setPitchOffset(_previousPitch, transpose);
      jungle.outputGain.gain.setValueAtTime(_previousBoost, _audioCtx.currentTime);
      jungle.setPan(_previousPan);
      // Truyền cấu hình Profile đích cho lõi DSP để nó tạo đúng cấu trúc Buffer từ đầu
      jungle.profile = _previousSoundProfile;
      jungle.setSoundProfile(_previousSoundProfile);
    }
    outputNodeMap.forEach((_, video) => video.playbackRate = _previousPlaybackRate);
    // === BƯỚC 3: ĐÁNH THỨC BASS MỖI KHI RESET THEO ĐÚNG CẤU HÌNH ĐÍCH CỦA BÀI ===
    if (outputNodeMap.size > 0 && isEnabled) {
      let hasPlayingVideo = false;
      for (const video of outputNodeMap.keys()) {
        if (isVideoPlaying(video)) {
          hasPlayingVideo = true;
          break;
        }
      }
      if (hasPlayingVideo && videoConnected) {
        // Sửa lỗi gọi trùng: Đọc và lật cờ khóa ngay lập tức
        const temporaryLogFlag = hasLoggedInitialWakeup;
        if (!temporaryLogFlag) {
          console.log(`%cINITIAL WAKEUP: ĐÁNH THỨC BASS THEO PROFILE ĐÍCH [${_previousSoundProfile}]!`, "color:purple;font-weight:bold;font-size:16px");
          hasLoggedInitialWakeup = true;
        }
        // Kích hoạt mạch Wakeup dựa trên linh hồn âm thanh thực tế của bài hát đó
        applyHeldSettings().then(() => {
          if (!temporaryLogFlag) {
            console.log("%cINITIAL WAKEUP HOÀN TẤT – BASS ĐÃ CÓ LỰC TỪ LẦN MỞ ĐẦU!", "color:gold;font-weight:bold;font-size:18px");
          }
        }).catch(err => {
          console.warn("Wakeup failed:", err);
        });
      }
    }
    console.log(`Settings reset execution completed. Current baseline profile: ${_previousSoundProfile}`);
  }
  async function applySettings(settings) {
    if (!isEnabled || !videoConnected) {
      console.log("applySettings: Extension not enabled or no video connected");
      return;
    }
    const jungle = getJungle();
    if (!jungle) {
      console.warn("applySettings: Jungle instance unavailable");
      return;
    }
    try {
      await ensureAudioContext();
      const validProfiles = ["warm", "bright", "bassHeavy", "vocal", "proNatural", "karaokeDynamic", "rockMetal", "smartStudio"];
      const realUrl = getRealVideoUrl();
      const favItem = favoritesMap.get(realUrl);
      // Chuẩn hóa soundProfile
      let soundProfile = settings.soundProfile || favItem?.soundProfile || _previousSoundProfile || "proNatural";
      if (typeof soundProfile === 'string' && soundProfile.includes('-')) {
        soundProfile = soundProfile.replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      }
      if (!validProfiles.includes(soundProfile)) {
        soundProfile = "proNatural";
      }
      // Chuẩn hóa target values
      let targetPan = parseFloat(settings.pan ?? favItem?.pan ?? _previousPan);
      if (isNaN(targetPan) || targetPan < -1 || targetPan > 1) targetPan = _previousPan || 0;
      let targetBoost = parseFloat(settings.boost ?? favItem?.boost ?? _previousBoost);
      if (isNaN(targetBoost) || targetBoost < 0.1 || targetBoost > 10) targetBoost = _previousBoost || 0.8;
      // 🛡️ CHỐT CHẶN TIÊU DIỆT LÀN SÓNG NGẦM: Nếu có luồng Wakeup cũ từ resetToDefault đang chạy, GIẾT NGAY để tránh xung đột cấu trúc node!
      if (_currentWakeupInterval) {
        clearInterval(_currentWakeupInterval);
        _currentWakeupInterval = null;
        console.log("%c[Mạch Bảo Vệ] Đã dập tắt 1 bộ đếm Wakeup chạy ngầm chống xung đột luồng!", "color:crimson;font-weight:bold");
      }
      // 🛡️ CHỐT CHẶN TUYỆT ĐỐI: Khởi tạo cờ hiệu ép chạy lần đầu khi nạp ứng dụng
      if (window._needsInitialForceApply === undefined) {
        window._needsInitialForceApply = true;
      }
      // Kiểm tra thay đổi (Tích hợp cờ hiệu toàn cục chống lỗi Nuốt Biến khi Reload Extension)
      const hasChanges = (window._needsInitialForceApply || (settings.pitch !== undefined && parseFloat(settings.pitch) !== _previousPitch) || (settings.playbackRate !== undefined && parseFloat(settings.playbackRate) !== _previousPlaybackRate) || (targetBoost !== _previousBoost) || (targetPan !== _previousPan) || (settings.transpose !== undefined && settings.transpose !== transpose) || (soundProfile !== _previousSoundProfile) || (favItem && (favItem.pitch != _previousPitch || favItem.playbackRate != _previousPlaybackRate || parseFloat(favItem.boost) != _previousBoost || parseFloat(favItem.pan) != _previousPan || favItem.transpose !== transpose || (favItem.soundProfile && favItem.soundProfile.replace(/-([a-z])/g, (_, l) => l.toUpperCase()) !== _previousSoundProfile))));
      if (!hasChanges && !settings.isUserInteraction && !settings.forceApply) {
        console.log("applySettings: No changes detected → skip");
        return;
      }
      // Áp dụng pitch & transpose
      if (settings.pitch !== undefined || (favItem && favItem.pitch !== undefined) || settings.transpose !== undefined || (favItem && favItem.transpose !== undefined)) {
        _previousPitch = parseFloat(settings.pitch ?? favItem?.pitch ?? _previousPitch);
        transpose = settings.transpose ?? favItem?.transpose ?? transpose;
        jungle.setPitchOffset(_previousPitch, transpose);
      }
      // Áp dụng playbackRate
      if (settings.playbackRate !== undefined || (favItem && favItem.playbackRate !== undefined)) {
        _previousPlaybackRate = parseFloat(settings.playbackRate ?? favItem?.playbackRate ?? _previousPlaybackRate);
        outputNodeMap.forEach((_, video) => video.playbackRate = _previousPlaybackRate);
      }
      // Xác định có cần đổi profile không
      const needProfileChange = (soundProfile !== _previousSoundProfile || settings.forceApply || !!favItem || settings.isUserInteraction || window._needsInitialForceApply);
      // Hàm re-apply pan & boost (chắc chắn work)
      const reapplyPanAndBoost = () => {
        if (targetBoost !== _previousBoost || settings.forceApply || !!favItem || settings.isUserInteraction || window._needsInitialForceApply) {
          _previousBoost = targetBoost;
          jungle.outputGain.gain.setValueAtTime(_previousBoost, _audioCtx.currentTime);
        }
        if (targetPan !== _previousPan || settings.forceApply || !!favItem || settings.isUserInteraction || window._needsInitialForceApply) {
          _previousPan = targetPan;
          jungle.setPan(_previousPan);
        }
        console.log("%cRE-APPLIED PAN & BOOST – WORK 100% MỌI BÀI!", "color:lime;font-weight:bold");
        // Xóa cờ hiệu sau khi luồng âm thanh đầu tiên đã được nạp thành công vào hệ thống phần cứng
        window._needsInitialForceApply = false;
      };
      // Nếu cần đổi profile → apply profile trước → delay nhỏ → re-apply pan/boost
      // Mã tối ưu
      if (needProfileChange && validProfiles.includes(soundProfile)) {
        _previousSoundProfile = soundProfile;
        jungle.setSoundProfile(_previousSoundProfile);
        if (window._profileChangeTimeout) {
          clearTimeout(window._profileChangeTimeout);
        }
        window._profileChangeTimeout = setTimeout(() => {
          reapplyPanAndBoost();
          window._profileChangeTimeout = null;
        }, 80);
      } else {
        reapplyPanAndBoost();
      }
      // Log thành công đầy đủ thông số cấu hình âm thanh
      console.log("%c⚡ INITIAL WAKEUP HOÀN TẤT – BASS ĐÃ CÓ LỰC TỪ LẦN MỞ ĐẦU!", "color:lime;font-weight:bold;font-size:20px", {
        pitch: _previousPitch,
        playbackRate: _previousPlaybackRate,
        boost: _previousBoost,
        pan: _previousPan,
        transpose,
        soundProfile: _previousSoundProfile,
        source: settings.isUserInteraction ? "User interaction" : (favItem ? "Favorites" : "Hold/Previous"),
        needProfileChange,
        videoUrl: realUrl
      });
      // Gửi cập nhật background
      if (isExtensionValid()) {
        chrome.runtime.sendMessage({
          type: "settingsUpdated",
          pitch: _previousPitch,
          playbackRate: _previousPlaybackRate,
          boost: _previousBoost,
          pan: _previousPan,
          transpose,
          soundProfile: _previousSoundProfile,
          holdState: isHeld,
          videoSrc: realUrl
        });
      }
    } catch (error) {
      handleError("Error applying settings:", error);
    }
  }
  async function applyHeldSettings() {
  if (!isEnabled || !videoConnected) {
    console.log("applyHeldSettings: Extension not enabled or no video connected");
    return;
  }

  const jungle = getJungle();
  if (!jungle) {
    console.warn("applyHeldSettings: Jungle instance unavailable");
    return;
  }

  try {
    await ensureAudioContext();

    // Áp pitch + tốc độ ngay
    jungle.setPitchOffset(_previousPitch, transpose);
    outputNodeMap.forEach((_, video) => {
      video.playbackRate = _previousPlaybackRate;
    });

    // Dọn interval cũ (nếu còn sót)
    if (window._currentWakeupInterval) {
      clearInterval(window._currentWakeupInterval);
      window._currentWakeupInterval = null;
    }

    const currentProfile = _previousSoundProfile || "proNatural";

    // === GỌI 1 LẦN NGAY (thay vì spam 6 lần) ===
    jungle.setSoundProfile(currentProfile);

    // Gọi thêm 1 lần sau 180ms để chắc graph Web Audio đã ổn định
    // (chỉ 1 lần, không dùng setInterval)
    const secondApplyTimer = setTimeout(() => {
      if (jungle && typeof jungle.setSoundProfile === "function") {
        jungle.setSoundProfile(currentProfile);
      }
    }, 180);

    // Re-apply boost + pan sau khi profile đã ổn
    setTimeout(() => {
      if (_audioCtx && jungle.outputGain?.gain) {
        jungle.outputGain.gain.setValueAtTime(
          _previousBoost,
          _audioCtx.currentTime
        );
      }
      if (typeof jungle.setPan === "function") {
        jungle.setPan(_previousPan);
      }
      console.log(
        "%cHOLD MODE: FINAL RE-APPLY BOOST & PAN – HOÀN TẤT!",
        "color:lime;font-weight:bold"
      );
    }, 450);

    // Lưu timer để có thể clear nếu cần (tùy chọn)
    window._heldSecondApplyTimer = secondApplyTimer;

    console.log("%cHOLD SETTINGS ÁP DỤNG (1–2 lần) – SẠCH, KHÔNG NHÁY!", "color:lime;font-weight:bold", {
      profile: currentProfile,
      boost: _previousBoost,
      pan: _previousPan
    });

    // Gửi trạng thái về popup
    if (isExtensionValid()) {
      chrome.runtime.sendMessage({
        type: "settingsUpdated",
        pitch: _previousPitch,
        playbackRate: _previousPlaybackRate,
        boost: _previousBoost,
        pan: _previousPan,
        transpose,
        soundProfile: currentProfile,
        holdState: isHeld,
        videoSrc: currentVideoSrc || getRealVideoUrl()
      });
    }
  } catch (error) {
    handleError("Error in applyHeldSettings:", error);
  }
}

  async function connectVideo(video) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;
    if (!isEnabled) {
      videoConnected = false;
      return;
    }
    try {
      await ensureAudioContext();
    } catch (error) {
      console.error("Failed to ensure AudioContext:", error.message);
      videoConnected = false;
      return;
    }

    const nodeData = await getOutputNode(video);
    if (!nodeData) {
      if (outputNodeMap.has(video)) {
        console.log("Get node failed, disconnecting to clean state...");
        disconnectVideo(video);
      }
      videoConnected = false;
      return;
    }
    const realUrl = getRealVideoUrl();

    // 🚀 THOÁT SỚM BẢO VỆ CPU: Nếu mạch âm thanh đã nối đúng url này rồi thì giữ nguyên
    if (nodeData.pitchShifterConnected && currentVideoSrc === realUrl) {
      videoConnected = true;
      return;
    }

    const outputNode = nodeData.outputNode;
    const jungle = getJungle();
    if (!jungle) {
      videoConnected = false;
      return;
    }

    try {
      if (!nodeData.pitchShifterConnected) {
        outputNode.connect(jungle.input);
        nodeData.pitchShifterConnected = true;
      }
      if (nodeData.destinationConnected) {
        try {
          outputNode.disconnect(_audioCtx.destination);
        } catch (e) {}
        nodeData.destinationConnected = false;
      }
      if (!jungle.isStarted) {
        jungle.start();
        jungle.isStarted = true;
      }

      const favoritesArray = (await getStorage("favorites")) || [];
      favoritesMap.clear();
      favoritesArray.forEach(f => favoritesMap.set(f.link, f));
      const favItem = favoritesMap.get(realUrl);

      if (favItem) {
        _previousPitch = favItem.pitch || 0;
        _previousPlaybackRate = favItem.playbackRate || 1;
        _previousBoost = favItem.boost || 0.8;
        _previousPan = favItem.pan || 0;
        _previousSoundProfile = favItem.soundProfile || "proNatural";
        transpose = favItem.transpose !== undefined ? favItem.transpose : true;
        _currentBPM = favItem.bpm || null;
        _currentKey = favItem.key || null;
        await applySettings({
          pitch: _previousPitch,
          playbackRate: _previousPlaybackRate,
          boost: _previousBoost,
          pan: _previousPan,
          transpose,
          soundProfile: _previousSoundProfile,
          forceApply: true
        });
        currentVideoSrc = realUrl;
        console.log("Applied favorite settings for:", realUrl, favItem);
      } else {
        if (!isHeld) {
          resetToDefault();
          await applySettings({
            soundProfile: _previousSoundProfile
          });
          currentVideoSrc = realUrl;
          console.log("Reset to default for new video:", realUrl);
        } else {
          await applyHeldSettings();
          currentVideoSrc = realUrl;
          console.log("HOLD MODE: ĐÃ ÁP DỤNG CẤU HÌNH RIÊNG KHI QUA BÀI!", realUrl);
        }
      }
      videoConnected = true;
      if (isVideoPlaying(video) && isExtensionValid()) {
        chrome.runtime.sendMessage({
          type: "videoChanged",
          videoSrc: currentVideoSrc,
          isFavorite: !!favItem,
          pitch: _previousPitch,
          playbackRate: _previousPlaybackRate,
          boost: _previousBoost,
          pan: _previousPan,
          transpose,
          bpm: _currentBPM,
          key: _currentKey,
          title: document.title,
          soundProfile: _previousSoundProfile,
          holdState: isHeld
        });
      }
      console.log("Video connected:", realUrl);
    } catch (error) {
      console.error("Error connecting video:", error.message);
      videoConnected = false;
    }
  }

  function disconnectVideo(video) {
    const nodeData = outputNodeMap.get(video);
    if (!nodeData || !_audioCtx || !_jungle) {
      videoConnected = false;
      return;
    }
    try {
      nodeData.outputNode.disconnect();
      nodeData.pitchShifterConnected = false;

      // ✅ ĐÃ SỬA: Chỉ nối lại loa gốc nếu Context chưa bị hủy (tránh treo luồng media hệ thống)
      if (_audioCtx && _audioCtx.state !== "closed") {
        nodeData.outputNode.connect(_audioCtx.destination);
        nodeData.destinationConnected = true;
      }

      video.playbackRate = 1;
      const realUrl = getRealVideoUrl();
      const favItem = favoritesMap.get(realUrl);
      if (!favItem || !isHeld) {
        currentVideoSrc = null;
      }
      videoConnected = false;

      if (!document.body.contains(video)) {
        outputNodeMap.delete(video);
        console.log("[AudioEngine] Đã giải phóng một thẻ video cũ khỏi bộ nhớ.");
      } else {
        console.log("[AudioEngine] Tạm ngắt kết nối, giữ lại Node gốc để tái sử dụng.");
      }
    } catch (error) {
      console.error("Error disconnecting video:", error);
    }
  }

  function disconnectAllVideos() {
  // Ngắt kết nối tất cả video vật lý
  outputNodeMap.forEach((_, video) => disconnectVideo(video));

  // 🛡️ CHỐT CHẶN THÔNG MINH: Quét và chỉ dọn dẹp các thẻ video chết để giải phóng RAM triệt để
  outputNodeMap.forEach((_, video) => {
    if (!document.body.contains(video)) {
      outputNodeMap.delete(video);
    }
  });

  // ✅ GIỮ NGUYÊN LOGIC GỐC: Chỉ clear Map khi AudioContext thực sự đã đóng hoàn toàn
  if (_audioCtx && _audioCtx.state === "closed") {
    outputNodeMap.clear();
  }

  // ✅ ĐÃ ĐỒNG BỘ: Loại bỏ hoàn toàn sự kiện theo cấu trúc Object để giải phóng RAM triệt để
  videoListeners.forEach((listeners, video) => {
    try {
      video.removeEventListener("playing", listeners.playing);
      video.removeEventListener("error", listeners.error);
      video.removeEventListener("ended", listeners.ended);
      video.removeEventListener("loadedmetadata", listeners.loadedmetadata);
      video.removeEventListener("play", listeners.play);
    } catch (e) {}
  });
  videoListeners.clear();

  videoConnected = false;
  currentVideoSrc = null;
  resetToDefault();

  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }

  if (window._videoSrcObserver) {
    window._videoSrcObserver.disconnect();
    window._videoSrcObserver = null;
  }
  if (window._dialogObserver) {
    window._dialogObserver.disconnect();
    window._dialogObserver = null;
  }
  if (window._updateInteractionHandler) {
    ['mousemove', 'click', 'keydown'].forEach(event => {
      document.removeEventListener(event, window._updateInteractionHandler);
    });
    window._updateInteractionHandler = null;
  }
  if (window._triggerStripInterval) {
    clearInterval(window._triggerStripInterval);
    window._triggerStripInterval = null;
  }

  // === CLEANUP TOÀN BỘ INTERVAL + TIMER (CHỐNG RÒ RỈ RAM TUYỆT ĐỐI) ===
  if (_nonstopInterval) {
    clearInterval(_nonstopInterval);
    _nonstopInterval = null;
  }

  if (_currentWakeupInterval) {
    clearInterval(_currentWakeupInterval);
    _currentWakeupInterval = null;
  }

  // Dọn dẹp các mạch vòng lặp Master trên window
  if (window._masterLoopInterval) {
    clearInterval(window._masterLoopInterval);
    window._masterLoopInterval = null;
  }
  if (window._fallbackInterval) {
    clearInterval(window._fallbackInterval);
    window._fallbackInterval = null;
  }
  if (window._deadNodePrunerInterval) {
    clearInterval(window._deadNodePrunerInterval);
    window._deadNodePrunerInterval = null;
  }
  if (window._currentWakeupInterval) {
    clearInterval(window._currentWakeupInterval);
    window._currentWakeupInterval = null;
  }

  // ✅ BỔ SUNG: Dọn timer lần gọi setSoundProfile thứ 2 của Hold mode
  if (window._heldSecondApplyTimer) {
    clearTimeout(window._heldSecondApplyTimer);
    window._heldSecondApplyTimer = null;
  }

  if (typeof stopSimulation === "function") {
    stopSimulation();
  }

  console.log("All videos disconnected + SMART CACHE RETAIN – MƯỢT MÀ KHÔNG KHỰNG HÌNH!");
}

  function isVideoPlaying(video) {
    return video.currentTime > 0 && !video.paused && !video.ended && video.readyState > 2 && !video.error;
  }

  // === CÁC HÀM TIỆN ÍCH HỖ TRỢ TRÁNH TRÙNG LẶP TIMER ===
  function setupNonstopTimer() {
    if (_nonstopInterval) clearInterval(_nonstopInterval);
    _nonstopInterval = setInterval(() => {
      if (typeof simulateUserInteraction === "function") simulateUserInteraction();
    }, NONSTOP_INTERACTION_INTERVAL);
  }

  function setupNonstopTimerIfPlaying() {
    let isPlaying = false;
    document.querySelectorAll("video").forEach(v => {
      if (isVideoPlaying(v)) isPlaying = true;
    });
    if (isPlaying) setupNonstopTimer();
  }

  function listenForPlay(video) {
    // 🛡️ CHỐNG TRÙNG LẶP CHÍ MẠNG: Gỡ bỏ toàn bộ listener cũ trước khi gắn mới (YouTube dùng lại thẻ video)
    if (videoListeners.has(video)) {
      const old = videoListeners.get(video);
      try {
        video.removeEventListener("playing", old.playing);
        video.removeEventListener("error", old.error);
        video.removeEventListener("ended", old.ended);
        video.removeEventListener("loadedmetadata", old.loadedmetadata);
        video.removeEventListener("play", old.play);
      } catch (e) {}
      videoListeners.delete(video);
    }

    const playingHandler = () => {
      if (!video.error) connectVideo(video);
      else if (typeof handleError === "function") handleError("Video playback error:", video.error);
    };

    const errorHandler = () => disconnectVideo(video);

    const endedHandler = () => {
      const realUrl = getRealVideoUrl();
      const favItem = favoritesMap.get(realUrl);
      if (!isHeld && !favItem) {
        resetToDefault();
        currentVideoSrc = null;
        try {
          if (chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage({
              type: "videoChanged",
              videoSrc: realUrl,
              isFavorite: false,
              pitch: _previousPitch,
              playbackRate: _previousPlaybackRate,
              boost: _previousBoost,
              pan: _previousPan,
              transpose,
              bpm: _currentBPM,
              key: _currentKey,
              title: document.title,
              soundProfile: _previousSoundProfile,
              holdState: isHeld
            }, () => {
              if (chrome.runtime.lastError) return;
            });
          }
        } catch (e) {
          console.warn("Could not send videoChanged message:", e.message);
        }
      } else {
        console.log(`Keeping settings due to hold state: ${isHeld} or favorite item exists`);
      }
      // Tái vũ trang bộ nghe sự kiện cho lượt phát tiếp theo trên thẻ video này
      listenForPlay(video);
    };

    const loadedMetadataHandler = () => {
      const realUrl = getRealVideoUrl();
      if (realUrl !== currentVideoSrc) {
        connectVideo(video);
      }
    };

    const playHandler = () => {
      const realUrl = getRealVideoUrl();
      if (isVideoPlaying(video) && realUrl !== currentVideoSrc) {
        connectVideo(video);
        setupNonstopTimerIfPlaying();
      }
    };

    // Đăng ký bộ sự kiện mới một cách khoa học
    video.addEventListener("playing", playingHandler, {
      once: true
    });
    video.addEventListener("error", errorHandler, {
      once: true
    });
    video.addEventListener("ended", endedHandler, {
      once: true
    });
    video.addEventListener("loadedmetadata", loadedMetadataHandler);
    video.addEventListener("play", playHandler);

    // Lưu trữ toàn bộ tham chiếu để hàm dọn rác tổng (disconnectAllVideos) có thể bứng sạch sành sanh
    videoListeners.set(video, {
      playing: playingHandler,
      error: errorHandler,
      ended: endedHandler,
      loadedmetadata: loadedMetadataHandler,
      play: playHandler
    });

    if (isVideoPlaying(video)) connectVideo(video);
  }

  function initVideoObservers() {
    if (!isEnabled) return;
    if (_observer) _observer.disconnect();

    // Phát hiện Shorts để điều chỉnh hành vi
    const isShort = window.location.href.includes('/shorts/');
    if (isShort) {
      console.log("YouTube Shorts detected – running observers with reduced nonstop features");
    }

    const target = document.querySelector("main") || document.body;
    _observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        Array.from(mutation.addedNodes).forEach(node => {
          if (node instanceof HTMLVideoElement) {
            // ✅ ĐÃ TỐI ƯU: Chỉ gọi listenForPlay, không gắn thêm listener ẩn danh bên ngoài nữa
            listenForPlay(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll("video").forEach(v => {
              listenForPlay(v);
            });
          }
        });
      });
    });

    _observer.observe(target, {
      childList: true,
      subtree: true
    });

    // Gắn listener bảo vệ cho các video đang có sẵn trong DOM
    document.querySelectorAll("video").forEach(video => {
      listenForPlay(video);
    });

    // 🚀 ĐÃ ĐỒNG BỘ: Gán thẳng vào biến window để bộ dọn rác tổng (disconnectAllVideos) có thể clear sạch
    if (window._masterLoopInterval) clearInterval(window._masterLoopInterval);
    window._masterLoopInterval = setInterval(() => {
      let isPlaying = false;
      document.querySelectorAll("video").forEach(video => {
        const realUrl = getRealVideoUrl();
        if (isVideoPlaying(video)) {
          isPlaying = true;
          if (realUrl !== currentVideoSrc) {
            connectVideo(video);
          }
        }
      });
    }, 3000);

    // Quản lý tương tác chuột, phím để reset chu kỳ tương tác phẳng
    // 🚀 Gán vào window để lần gọi initVideoObservers() kế tiếp gỡ đúng handler cũ, tránh chồng listener
    if (window._updateInteractionHandler) {
      ['mousemove', 'click', 'keydown'].forEach(event => {
        document.removeEventListener(event, window._updateInteractionHandler);
      });
    }
    const updateInteraction = () => {
      _lastInteractionTime = Date.now();
      let isPlaying = false;
      document.querySelectorAll("video").forEach(video => {
        if (isVideoPlaying(video)) isPlaying = true;
      });
      if (isPlaying) {
        setupNonstopTimer();
      }
    };
    window._updateInteractionHandler = updateInteraction;

    ['mousemove', 'click', 'keydown'].forEach(event => {
      document.addEventListener(event, updateInteraction, {
        passive: true
      });
    });

    // 🚀 ĐÃ ĐỒNG BỘ: Chu kỳ dự phòng kiểm tra trạng thái phẳng dài (Khớp chuẩn biến window để dọn rác)
    if (window._fallbackInterval) clearInterval(window._fallbackInterval);
    window._fallbackInterval = setInterval(() => {
      let isPlaying = false;
      document.querySelectorAll("video").forEach(video => {
        if (isVideoPlaying(video)) isPlaying = true;
      });
      if (!isPlaying) {
        document.querySelectorAll("video").forEach(video => {
          const realUrl = getRealVideoUrl();
          if (realUrl !== currentVideoSrc) {
            connectVideo(video);
            if (isVideoPlaying(video)) setupNonstopTimer();
          }
        });
      } else {
        setupNonstopTimer();
      }
    }, VIDEO_CHECK_FALLBACK_INTERVAL);

    console.log("Video and nonstop observers initialized – FULL SUPPORT FOR SHORTS WITH SMART BEHAVIOR!");
  }
  async function restoreState() {
    isEnabled = (await getStorage("isEnabled")) || false;
    isHeld = false;
    if (!isEnabled) {
      if (_nonstopInterval) {
        clearInterval(_nonstopInterval);
        _nonstopInterval = null;
      }
      stopSimulation(); // Dừng simulation nếu tắt extension
      return;
    }
    const videos = document.querySelectorAll("video");
    const favoritesArray = (await getStorage("favorites")) || [];
    favoritesMap.clear();
    favoritesArray.forEach(f => favoritesMap.set(f.link, f));

    // ✅ ĐÃ TỐI ƯU: Chuyển giao toàn bộ cho hạ tầng lõi quản lý Object, triệt tiêu listener ẩn danh
    videos.forEach(video => {
      listenForPlay(video);
    });

    // Theo dõi tương tác người dùng thực tế một cách thông minh
    const updateInteraction = () => {
      _lastInteractionTime = Date.now();
      let isPlaying = false;
      document.querySelectorAll("video").forEach(video => {
        if (isVideoPlaying(video)) isPlaying = true;
      });
      if (isPlaying) setupNonstopTimer();
    };

    ['mousemove', 'click', 'keydown'].forEach(event => {
      document.removeEventListener(event, updateInteraction); // Chống trùng lặp sự kiện tương tác
      document.addEventListener(event, updateInteraction, {
        passive: true
      });
    });

    // ✅ ĐÃ ĐỒNG BỘ: Kiểm tra trạng thái dài, khóa chặt vào biến window để bộ dọn rác tổng kiểm soát được
    if (window._fallbackInterval) clearInterval(window._fallbackInterval);
    window._fallbackInterval = setInterval(() => {
      let isPlaying = false;
      document.querySelectorAll("video").forEach(video => {
        if (isVideoPlaying(video)) isPlaying = true;
      });
      if (!isPlaying) {
        document.querySelectorAll("video").forEach(video => {
          const realUrl = getRealVideoUrl();
          if (realUrl !== currentVideoSrc) {
            connectVideo(video);
            if (isVideoPlaying(video)) setupNonstopTimer();
          }
        });
      } else {
        setupNonstopTimer();
      }
    }, VIDEO_CHECK_FALLBACK_INTERVAL);

    console.log("State restored with isEnabled:", isEnabled);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // === BẢO VỆ KHI RELOAD EXTENSION THỦ CÔNG ===
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      sendResponse({
        status: "invalidated"
      });
      return false;
    }
    if (!isExtensionValid()) {
      sendResponse({
        status: "notSupported",
        message: "Tab not supported"
      });
      return false;
    }

    // === XỬ LÝ MỞ AJU PANEL ===
    if (request && request.action === "OPEN_AJU_PANEL") {
      injectAjuEqualizerPanel();
      sendResponse({
        status: "AJU_Panel_Opened"
      });
      return false;
    }

    // === XỬ LÝ DOWNLOAD COVER TỪ POPUP ===
    if (request.type === "downloadCover") {
      downloadCover().then(() => {
        sendResponse({
          status: "success"
        });
      }).catch(err => {
        sendResponse({
          status: "error",
          message: err.message || "Lỗi tạo cover"
        });
      });
      return true; // Bất đồng bộ
    }

    try {
      const requestType = request.type || request.action;
      if (requestType === "get") {
        const activeVideo = Array.from(outputNodeMap.keys()).find(isVideoPlaying);
        const videoSrc = activeVideo ? getRealVideoUrl() : currentVideoSrc;
        const presetId = _previousSoundProfile.replace(/([A-Z])/g, '-$1').toLowerCase();
        sendResponse({
          playbackRate: _previousPlaybackRate,
          pitch: _previousPitch,
          boost: _previousBoost,
          pan: _previousPan,
          enabled: isEnabled,
          transpose,
          bpm: _currentBPM,
          key: _currentKey,
          title: document.title,
          videoSrc,
          isFavorite: favoritesMap.has(videoSrc),
          soundProfile: presetId,
          holdState: isHeld,
          status: "success"
        });
        return false;
      }

      if (requestType === "getBPM" || requestType === "getSongKey" || requestType === "calculateBPM") {
        if (!isEnabled) {
          sendResponse({
            status: "error",
            message: "Extension not enabled"
          });
          return false;
        }
        calculateBPM().then(result => sendResponse({
          status: result.bpm ? "success" : "error",
          ...result
        })).catch(error => sendResponse({
          status: "error",
          message: error.message
        }));
        return true;
      }

      if (requestType === "restore" || requestType === "refreshState") {
        console.log("Áp dụng thiết lập âm thanh:", request.soundProfile || _previousSoundProfile, request);
        restoreState().then(() => {
          sendResponse({
            status: "success",
            message: "State restored successfully"
          });
        }).catch(error => sendResponse({
          status: "error",
          message: error.message
        }));
        return true;
      }

      if (request.enabled !== undefined) {
        isEnabled = request.enabled;
        setStorage("isEnabled", isEnabled);
        if (isEnabled) {
          initVideoObservers();
          restoreState().catch(() => sendResponse({
            status: "error",
            message: "State restoration failed"
          }));
        } else {
          disconnectAllVideos();
        }
        sendResponse({
          status: "success",
          enabled: isEnabled
        });
        return false;
      }

      if (requestType === "hold") {
        isHeld = request.holdState;
        console.log(`Hold state changed to: ${isHeld}`);
        if (!isHeld) {
          applySettings({
            soundProfile: _previousSoundProfile
          });
        }
        sendResponse({
          status: "success",
          holdState: isHeld
        });
        return false;
      }

      if (requestType === "applyPreset") {
        const preset = request.preset;
        const validProfiles = ["warm", "bright", "bassHeavy", "vocal", "proNatural", "karaokeDynamic", "rockMetal", "smartStudio"];
        if (validProfiles.includes(preset)) {
          // FIX: applyHeldSettings() (chạy mỗi khi video kết nối lại/reset) hẹn giờ gọi lại
          // setSoundProfile(profile CŨ) sau 180ms để "chắc đồ thị Web Audio đã ổn định", nhưng timer này
          // trước đây chỉ được huỷ khi tắt extension (disconnectAllVideos), KHÔNG huỷ khi người dùng bấm
          // chọn profile mới. Nếu vừa đổi bài/reset xong (timer đang đếm) mà bấm nhanh sang profile khác
          // trong đúng 180ms đó, timer cũ sẽ áp đè lại profile CŨ ngay sau khi profile MỚI vừa lên -> đúng
          // hiện tượng thi thoảng mất bass khi bấm cấu hình nhanh, dù cache đã tách theo profile.
          if (window._heldSecondApplyTimer) {
            clearTimeout(window._heldSecondApplyTimer);
            window._heldSecondApplyTimer = null;
          }
          applySettings({
            soundProfile: preset
          }).then(() => {
            _previousSoundProfile = preset;
            sendResponse({
              status: "success",
              preset
            });
          }).catch(error => sendResponse({
            status: "error",
            message: error.message
          }));
        } else {
          sendResponse({
            status: "error",
            message: "Invalid preset"
          });
        }
        return true;
      }

      if (request.pitch !== undefined || request.playbackRate !== undefined || request.boost !== undefined || request.pan !== undefined || request.transpose !== undefined || request.soundProfile !== undefined) {
        applySettings(request).then(() => sendResponse({
          status: "success",
          soundProfile: _previousSoundProfile
        })).catch(error => sendResponse({
          status: "error",
          message: error.message
        }));
        return true;
      }

      if (requestType === "suspend") {
        // ✅ ĐÃ ĐỒNG BỘ: Ép hệ thống dọn sạch sành sanh bộ đếm ngầm và Listener trước khi hủy Context
        disconnectAllVideos();
        if (_audioCtx) {
          try {
            _audioCtx.close();
          } catch (e) {}
        }
        _audioCtx = null;
        _jungle = null;
        videoConnected = false;
        isHeld = false;
        resetToDefault();
        sendResponse({
          status: "suspended"
        });
        return false;
      }

      sendResponse({
        status: "error",
        message: "Unknown request type"
      });
      return false;
    } catch (error) {
      handleError("Error handling message:", error);
      sendResponse({
        status: "error",
        message: error.message
      });
      return false;
    }
  });
  // =========================================================================
  // CÔNG NGHỆ KHÓA RAM TỰ ĐỘNG: QUÉT DỌN CÁC NODE VIDEO ĐÃ CHẾT CỦA YOUTUBE
  // =========================================================================
  function pruneDeadVideoNodes() {
    // Nếu đang trong tiến trình ghi âm/cover, đóng băng dọn dẹp để dồn 100% CPU cho AV1
    if (typeof isCovering !== 'undefined' && isCovering === true) return;

    if (typeof outputNodeMap !== 'undefined' && outputNodeMap instanceof Map && outputNodeMap.size > 0) {
      // ✅ ĐÃ SỬA: Lấy chuẩn nodeData từ Map ra để bóc tách cấu trúc
      for (const [video, nodeData] of outputNodeMap.entries()) {

        // Nếu thẻ video không còn tồn tại trên cây thư mục DOM hiển thị của trang web
        if (video && !document.body.contains(video)) {
          try {
            const outputNode = nodeData ? nodeData.outputNode : null;

            // Chủ động ngắt kết nối vật lý nút âm thanh để giải phóng bộ nhớ giải mã lập tức
            if (outputNode && typeof outputNode.disconnect === 'function') {
              outputNode.disconnect();
            }

            // ✅ ĐÃ ĐỒNG BỘ: Gỡ bỏ toàn bộ 5 trình lắng nghe sự kiện để triệt tiêu hoàn toàn tham chiếu ngầm
            if (typeof videoListeners !== 'undefined' && videoListeners instanceof Map && videoListeners.has(video)) {
              const listeners = videoListeners.get(video);
              if (listeners) {
                video.removeEventListener("playing", listeners.playing);
                video.removeEventListener("error", listeners.error);
                video.removeEventListener("ended", listeners.ended);
                video.removeEventListener("loadedmetadata", listeners.loadedmetadata);
                video.removeEventListener("play", listeners.play);
              }
              videoListeners.delete(video);
            }

            // Xóa thực thể khỏi bản đồ lưu trữ chính
            outputNodeMap.delete(video);
            console.log("[AudioEngine] Tuần tra RAM: Đã bứng sạch một thẻ video chết rời khỏi DOM.");
          } catch (e) {
            // Silent fail an toàn nếu node đã bị trình duyệt ép hủy trước đó
          }
        }
      }
    }
  }

  // 🚀 KÍCH HOẠT LUỒNG KHỞI CHẠY HỆ THỐNG ĐỒNG BỘ
  (async () => {
    await restoreState();
    if (isEnabled) initVideoObservers();

    // ✅ ĐÃ ĐỒNG BỘ: Ghim chặt vào biến window để quản lý vòng đời, chống trùng lặp lặp tiến trình khi reload extension
    if (window._deadNodePrunerInterval) clearInterval(window._deadNodePrunerInterval);
    window._deadNodePrunerInterval = setInterval(pruneDeadVideoNodes, 10000);

    window.addEventListener("beforeunload", () => {
      if (window._deadNodePrunerInterval) {
        clearInterval(window._deadNodePrunerInterval);
        window._deadNodePrunerInterval = null;
      }
      disconnectAllVideos();
      if (typeof stopSimulation === "function") {
        stopSimulation();
      }
    });
  })();

  console.log("[Jungle Content] Injected successfully with Auto-RAM Lock (once)");
  // Dấu đóng ngoặc nhọn kết thúc toàn bộ file script lớn (nếu có IIFE bọc bên ngoài)
})();

// 2. NÚT BẤM NHÚNG THẲNG VÀO TRONG KHUNG PLAY VIDEO (ĐÃ SỬA LỖI LỌT RA BODY)
function insertTriggerStrip() {
  // Chỉ nhắm duy nhất mục tiêu tối cao: Thanh điều khiển bên phải của trình phát video YouTube
  const targetContainer = document.querySelector('.ytp-right-controls');
  const existingBtn = document.getElementById('open-aju-eq-btn');
  // Trường hợp 1: Trình phát video chưa tải xong (hoặc đang chuyển trang)
  if (!targetContainer) {
    // Nếu trước đó lỡ có nút nằm lạc trôi ở đâu đó (như body), dọn dẹp sạch sẽ ngay lập tức
    if (existingBtn) {
      existingBtn.closest('.aju-trigger-strip')?.remove();
    }
    return; // Kiên nhẫn chờ nhịp quét sau, tuyệt đối không chèn bừa bãi
  }
  // Trường hợp 2: Nút đã tồn tại trên trang
  if (existingBtn) {
    // Kiểm tra xem nút có nằm đúng trong lòng khung phát video hay không
    if (targetContainer.contains(existingBtn)) {
      return; // Đã nằm chuẩn vị trí, giữ nguyên không chạm vào
    } else {
      // Nếu nút tồn tại nhưng bị lạc sang chỗ khác (như góc trái body), xóa đi để ép nạp lại vào chỗ chuẩn
      existingBtn.closest('.aju-trigger-strip')?.remove();
    }
  }
  // Tiến hành tạo dải nút bấm cấu trúc chuẩn tương thích với thiết kế thanh điều khiển YouTube
  const strip = document.createElement('div');
  strip.className = 'aju-trigger-strip';
  strip.style.cssText = `
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        height: 100% !important;
        vertical-align: middle !important;
    `;
  strip.innerHTML = `
        <button id="open-aju-eq-btn" class="aju-open-modal-btn" title="Bật Bảng Tinh Chỉnh Âm Thanh Chuyên Sâu Studio Equalizer (AJU)">
            🎛️ Pitch Shifter DSP Matrix (AJU)
        </button>
    `;
  const btn = strip.querySelector('#open-aju-eq-btn');
  if (btn) {
    btn.style.cssText = `
            background: rgba(48, 209, 88, 0.12) !important;
            border: 1px solid #30d158 !important;
            color: #30d158 !important;
            padding: 0 12px !important;
            margin: 0 6px !important;
            height: 28px !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            font-size: 11px !important;
            font-weight: bold !important;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
            white-space: nowrap !important;
            line-height: 26px !important;
            box-sizing: border-box !important;
        `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#30d158';
      btn.style.color = '#000';
      btn.style.boxShadow = '0 0 10px rgba(48, 209, 88, 0.6)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(48, 209, 88, 0.12)';
      btn.style.color = '#30d158';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      injectAjuEqualizerPanel();
    });
  }
  // Chèn dải nút bấm vào vị trí đầu tiên của thanh điều khiển bên phải (đẹp và không bị khuất)
  targetContainer.insertBefore(strip, targetContainer.firstChild);
}
// Mạch kích hoạt liên tục phòng chống cơ chế chuyển đổi video ngầm của YouTube SPA
if (document.body) {
  insertTriggerStrip();
} else {
  document.addEventListener('DOMContentLoaded', insertTriggerStrip);
}
// Giảm thời gian Interval xuống 500ms để bắt góc khung phát cực nhanh mà không hề tốn RAM
// 🚀 Gán vào window để disconnectAllVideos() dọn được, tránh interval chạy mãi sau khi tắt extension
if (window._triggerStripInterval) clearInterval(window._triggerStripInterval);
window._triggerStripInterval = setInterval(insertTriggerStrip, 500);
// 3. HÀM DỰNG BẢNG ĐIỀU KHIỂN XUYÊN SHADOW DOM (CẬP NHẬT GRID LAYOUT CHO CO MẠNH)
function injectAjuEqualizerPanel() {
  const HOST_ID = 'aju-eq-shadow-host';
  let host = document.getElementById(HOST_ID);
  let shadowRoot;
  if (host) {
    shadowRoot = host.shadowRoot;
    const overlay = shadowRoot.getElementById('aju-modal-overlay');
    if (overlay) overlay.classList.add('is-visible');
    return;
  }
  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; z-index: 2147483747 !important;';
  document.body.appendChild(host);
  shadowRoot = host.attachShadow({
    mode: 'open'
  });
  const styleLink = document.createElement('style');
  styleLink.textContent = `
        .aju-modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(8, 8, 12, 0.65); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.18s cubic-bezier(0.4, 0, 0.2, 1); box-sizing: border-box; will-change: opacity; }
        .aju-modal-overlay.is-visible { opacity: 1; pointer-events: auto; }
        
        .aju-modal-content { position: relative; background: linear-gradient(145deg, #161622, #0d0d14); border: 1px solid rgba(48, 209, 88, 0.35); border-radius: 14px; width: 96%; max-width: 740px; padding: 18px; box-shadow: 0 16px 55px rgba(0, 0, 0, 0.65); color: #ffffff; font-family: system-ui, -apple-system, sans-serif; transform: translate3d(0,0,0); backface-visibility: hidden; }
        
        .aju-profile-manager { display: grid; grid-template-columns: 1fr; gap: 8px; margin: 10px 0; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
        .aju-manager-row-top { display: flex; gap: 8px; width: 100%; }
        .aju-manager-row-bottom { display: flex; gap: 6px; width: 100%; justify-content: space-between; }
        
        .aju-select { flex: 1.6; min-width: 0; background: #1c1c28; color: #fff; border: 1px solid rgba(255,255,255,0.1); padding: 6px 10px; border-radius: 5px; outline: none; font-size: 12px; cursor: pointer; }
        .aju-input { flex: 1; min-width: 0; background: #1c1c28; color: #fff; border: 1px solid rgba(255,255,255,0.1); padding: 6px 10px; border-radius: 5px; outline: none; font-size: 12px; }
        
        .aju-btn { flex: 1; text-align: center; background: #30d158; color: #000; border: none; padding: 7px 10px; border-radius: 5px; font-weight: 700; cursor: pointer; font-size: 11px; transition: all 0.1s; white-space: nowrap; }
        .aju-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .aju-btn-danger { background: rgba(255, 69, 0, 0.15) !important; color: #ff4500 !important; border: 1px solid rgba(255, 69, 0, 0.25) !important; }
        
        .aju-eq-body { display: flex; gap: 8px; height: 275px; align-items: flex-end; justify-content: center; padding: 10px; background: rgba(0, 0, 0, 0.5); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.04); overflow: hidden; margin-top: 10px; box-sizing: border-box; }
        .aju-slider-container { display: grid; flex-grow: 1; height: 100%; align-items: flex-end; }
        #aju-simple-sliders { grid-template-columns: repeat(5, minmax(65px, 1fr)); gap: 8px; }
        #aju-pro-sliders { grid-template-columns: repeat(10, minmax(34px, 1fr)); gap: 2px; }
        .aju-hidden { display: none !important; }
        .aju-track-wrapper { display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: space-between; box-sizing: border-box; width: 100%; overflow: hidden; padding: 2px 0; }
        .aju-val-bubble { font-family: 'Courier New', monospace; font-size: 11px; font-weight: 800; color: #ffffff; background: #1e1e2a; border: 1px solid rgba(255,255,255,0.08); padding: 2px 4px; border-radius: 4px; min-width: 32px; text-align: center; white-space: nowrap; margin-bottom: 4px; }
        .aju-slider-track { height: 165px; width: 6px; background: #222232; border-radius: 10px; position: relative; display: flex; align-items: center; justify-content: center; margin: 4px 0; border: 1px solid rgba(255,255,255,0.04); }
        .aju-v-slider { -webkit-appearance: none; appearance: none; transform: rotate(-90deg); width: 165px; height: 32px; background: transparent; outline: none; position: absolute; margin: 0; padding: 0; cursor: pointer; z-index: 2; }
        /* 1. BÓNG ĐÈN NEON XANH GREEN ĐẬM ĐẶC (CHO 5 VÀ 10 CỘT) */
        .aju-v-slider::-webkit-slider-thumb { 
            -webkit-appearance: none; 
            width: 15px; 
            height: 15px; 
            border-radius: 50%; 
            background: #30d158; /* Phủ toàn bộ màu green đậm đặc, không còn lõi trắng */
            border: none; 
            box-sizing: border-box;
            box-shadow: 0 0 8px #30d158, inset 0 0 3px rgba(0, 0, 0, 0.5); /* Độ sáng neon vừa phải ở chế độ chờ */
            transition: transform 0.15s ease, box-shadow 0.15s ease; 
        }

        /* KHI ĐANG HOẠT ĐỘNG (ĐƯỢC CLICK/KÉO): GIỮ NGUYÊN ĐỘ SÁNG NEON BÙNG LÊN */
        .aju-v-slider:focus::-webkit-slider-thumb,
        .aju-v-slider::-webkit-slider-thumb:active { 
            transform: scale(1.35); 
            background: #39ff14; /* Xanh neon cực sáng */
            box-shadow: 0 0 25px #39ff14, 0 0 10px #30d158, inset 0 0 4px rgba(255,255,255,0.6); /* Quầng sáng tỏa rộng như mixer cơ */
        }

        /* ĐOẠN TRUNG GIAN GIỮ NGUYÊN */
        .aju-side-wrapper { border-left: 1px solid rgba(255, 255, 255, 0.12); padding-left: 8px; min-width: 48px; margin-left: 4px; }
        
        /* 2. BÓNG ĐÈN NEON VÀNG ĐẬM ĐẶC (DÀNH RIÊNG CHO CỘT MASTER) */
        .master-slider::-webkit-slider-thumb { 
            background: #ffd60a !important; /* Phủ toàn bộ màu vàng đậm đặc phân biệt */
            border: none !important;
            box-shadow: 0 0 8px #ffd60a, inset 0 0 3px rgba(0, 0, 0, 0.5) !important; 
        }

        /* CỘT MASTER KHI ĐANG HOẠT ĐỘNG: GIỮ NGUYÊN ĐỘ SÁNG VÀNG RỰC */
        .master-slider:focus::-webkit-slider-thumb,
        .master-slider::-webkit-slider-thumb:active { 
            transform: scale(1.35); 
            background: #fff000 !important; /* Vàng chanh sáng rực */
            box-shadow: 0 0 25px #ffd60a, 0 0 10px #ffd60a, inset 0 0 4px rgba(255,255,255,0.6) !important; 
        }       
        
        .aju-toast-container { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; flex-direction: column; gap: 4px; pointer-events: none; }
        .aju-toast { background: #12121a; color: #fff; padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: bold; border: 1px solid #30d158; box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; transform: translate3d(0, -6px, 0); transition: all 0.15s ease; white-space: nowrap; }
        .aju-toast.show { opacity: 1; transform: translate3d(0, 0, 0); }
		/* NÚT CHUYỂN ĐỔI NGÔN NGỮ ĐẸP Ở GÓC TRÊN */
        .aju-lang-btn { background: rgba(255,255,255,0.04); color: #b3b3b3; border: 1px solid rgba(255,255,255,0.08); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.15s ease; display: flex; align-items: center; gap: 4px; outline: none; }
        .aju-lang-btn:hover { background: rgba(48, 209, 88, 0.12); color: #30d158; border-color: rgba(48, 209, 88, 0.3); box-shadow: 0 0 8px rgba(48, 209, 88, 0.2); }
    `;
  shadowRoot.appendChild(styleLink);

  function createSliderHtml(id, label, description, min = "-12", max = "12", step = "0.1", value = "0") {
    return `
            <div class="aju-track-wrapper" title="${description}">
                <div class="aju-val-bubble" id="val-${id}">${parseFloat(value).toFixed(1)}</div>
                <div class="aju-slider-track"><input type="range" class="aju-v-slider" id="aju-${id}" min="${min}" max="${max}" step="${step}" value="${value}"></div>
                <span style="font-size:10px; margin-top:6px; color:#b3b3b3; font-weight:bold; white-space:nowrap;">${label}</span>
            </div>
        `;
  }
  const overlay = document.createElement('div');
  overlay.id = 'aju-modal-overlay';
  overlay.className = 'aju-modal-overlay';
  overlay.innerHTML = `
        <div class="aju-modal-content">
            <div id="aju-toast-container" class="aju-toast-container"></div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
    <h3 style="margin:0; font-size:13px; color:#30d158; letter-spacing:0.5px;">🎛️ STUDIO EQUALIZER SUPREME (AI MATRIX)</h3>
    <div style="display:flex; align-items:center; gap:8px;">
        <div style="display:flex; align-items:center; gap:6px; background: rgba(0,0,0,0.4); padding: 4px 10px; border-radius: 20px;">
            <span style="font-size:11px; color:#ccc; font-weight:bold;" id="mode-text">Simple Mode</span>
            <input type="checkbox" id="aju-mode-toggle" style="cursor:pointer; scale: 1.1;">
        </div>
        <button id="aju-lang-toggle" class="aju-lang-btn">🌐 <span>EN</span></button>
        <span id="aju-close" style="font-size:20px; cursor:pointer; color:#aaa; font-weight:bold; margin-left:4px;">&times;</span>
    </div>
</div>

            <div class="aju-profile-manager">
                <div class="aju-manager-row-top">
                    <select id="aju-saved-profiles" class="aju-select">
                        <option value="">-- Chọn cấu hình xử lý --</option>
                        <optgroup label="✨ Siêu Thuật Toán AI Tự Động (Real-time)">
                           <option value="AI_Perfect_Balance">🤖 [AI] Smart Perfect Balance (Toàn Năng)</option>
                           <option value="AI_Auto_Genre">🎵 [AI] Intelligent Genre Flower</option>
                           <option value="AI_Vocal_Follower">🎤 [AI] Auto Vocal Clarity Master</option>
                           <option value="AI_Karaoke_Live">🎤 [AI] Real-time Dynamic Karaoke Adaptive</option>
                           <option value="AI_EDM_Energy">🔥 [AI] EDM Energy Drop Master</option>
                        </optgroup>
                        <optgroup label="🎤 Cấu Hình Đặc Chủng Hát Karaoke Studio">
                            <option value="KARAOKE_PRO_REVERB">✨ Karaoke Studio Cao Cấp - Trợ Lực Thoát Tiếng</option>
                            <option value="KARAOKE_DUET_WARMTH">❤️ Karaoke Giọng Nam/Nữ - Ấm Áp Dày Dặn</option>
                            <option value="KARAOKE_REMIX_BOOST">⚡ Karaoke Nhạc Sàn Remix - Trống Lực Giọng Sáng</option>
                        </optgroup>
                        <optgroup label="🎹 Nhà Thiết Kế Kỹ Sư Pro Preset">
                            <option value="PRESET_EDM">🔥 EDM & Dance - Siêu Bass Lực</option>
                            <option value="PRESET_BALLAD">🎵 Pop & Ballad - Rõ Lời Ngọt Ngào</option>
                            <option value="PRESET_VOCAL_PRO">🎙️ Vocal Boost Pro - Sáng Trung Cao</option>
                            <option value="PRESET_CINEMA">🎬 Cinema Surround - Hiệu Ứng Rạp Phim</option>
                            <option value="PRESET_ROCK">⚡ Rock & Metal - Đậm Khối Năng Lượng</option>
                            <option value="PRESET_ACOUSTIC">🎸 Acoustic - Tách Lớp Nhạc Cụ</option>
                            <option value="PRESET_CLASSIC">🎻 Classical - Cân Bằng Chi Tiết</option>
                            <option value="PRESET_LOFI">☕ Lo-Fi Chill - Ấm Áp Hoài Niệm</option>
                        </optgroup>
                        <optgroup label="💾 Cấu Hình Người Dùng Lưu" id="user-profiles-group">
                        </optgroup>
                    </select>
                    <input type="text" id="aju-profile-name" class="aju-input" placeholder="Tên tùy chỉnh...">
                </div>
                <div class="aju-manager-row-bottom">                    
                    <button id="aju-export-btn" class="aju-btn" style="background:#1e1e2a; color:#30d158; border:1px solid #30d158;">Xuất JSON</button>
                    <button id="aju-import-btn" class="aju-btn" style="background:#1e1e2a; color:#ffd60a; border:1px solid #ffd60a;">Nhập JSON</button>
					<button id="aju-save-btn" class="aju-btn">Lưu Lại</button>
                    <button id="aju-delete-btn" class="aju-btn aju-btn-danger">Xóa Bản Lưu</button>
                </div>
                <input type="file" id="aju-file-input" style="display:none;" accept=".json">
            </div>

            <div class="aju-eq-body">
                <div class="aju-slider-container" id="aju-simple-sliders">
                    ${createSliderHtml('s-bass', 'BASS', 'Dải trầm (60-250Hz): Tăng lực đánh và độ đầm cho trống kick, bassline.')}
                    ${createSliderHtml('s-mid', 'MID', 'Dải trung (250-2kHz): Độ dày và ấm cho nhạc cụ, thân giọng hát.')}
                    ${createSliderHtml('s-vocal', 'VOCAL', 'Dải trung cao (2-6kHz): Tăng độ rõ ràng và nổi bật của giọng hát.')}
                    ${createSliderHtml('s-treble', 'TREBLE', 'Dải cao (6-12kHz): Độ sáng, chi tiết của guitar, cymbal, hi-hat.')}
                    ${createSliderHtml('s-air', 'AIR', 'Siêu cao (12kHz+): Không gian mở, thoáng, độ tơi và ánh sáng tự nhiên.')}
                </div>
                
                <div class="aju-slider-container aju-hidden" id="aju-pro-sliders">
                    ${createSliderHtml('p-31', '31Hz', 'Sub-bass: Độ rung sâu, lực bass ngầm, cảm giác uy lực.')}
                    ${createSliderHtml('p-62', '62Hz', 'Kick & Bass Weight: Độ đầm, chắc của trống kick và bassline.')}
                    ${createSliderHtml('p-125', '125Hz', 'Bass Body: Độ ấm và đầy đặn của dải bass.')}
                    ${createSliderHtml('p-250', '250Hz', 'Low-Mid: Giảm độ đục, tăng độ rõ cho guitar và giọng hát.')}
                    ${createSliderHtml('p-500', '500Hz', 'Mid Low: Độ dày, ấm của giọng hát (đặc biệt giọng nam).')}
                    ${createSliderHtml('p-1k', '1kHz', 'Mid Presence: Độ rõ ràng của ca từ và trung tâm âm thanh.')}
                    ${createSliderHtml('p-2k', '2kHz', 'Upper Mid: Độ nổi bật, "đẩy" giọng hát lên phía trước.')}
                    ${createSliderHtml('p-4k', '4kHz', 'Presence & Attack: Độ sắc nét của nhạc cụ, attack của trống.')}
                    ${createSliderHtml('p-8k', '8kHz', 'Treble: Độ sáng, chi tiết cao, âm gió (s, sh, ch).')}
                    ${createSliderHtml('p-16k', '16kHz', 'Air & Brilliance: Không gian mở, độ lấp lánh và thoáng đãng.')}
                </div>
                
                <div class="aju-track-wrapper aju-side-wrapper" title="Âm lượng tổng (Master Gain): Điều tiết biên độ lớn nhỏ tổng thể sau bộ lọc.">
                    <div class="aju-val-bubble" id="val-master-gain">0.0</div>
                    <div class="aju-slider-track"><input type="range" class="aju-v-slider master-slider" id="aju-master-gain" min="-12" max="6" step="0.1" value="0"></div>
                    <span style="color:#ffd60a; font-size:10px; margin-top:6px; font-weight:bold;">MASTER</span>
                </div>
            </div>

            <div style="display:flex; justify-content:flex-start; margin-top:12px;">
                <button id="aju-reset-btn" class="aju-btn aju-btn-danger">Reset Mặc Định</button>
            </div>
        </div>
    `;
  shadowRoot.appendChild(overlay);
  setTimeout(() => overlay.classList.add('is-visible'), 50);
  // --- ĐOẠN KHỞI TẠO LOGIC NGÔN NGỮ TỰ ĐỘNG LƯU ---
  const langToggle = shadowRoot.getElementById('aju-lang-toggle');

  // Kiểm tra bộ nhớ tạm, nếu chưa từng chọn thì mặc định là tiếng Anh ('en') theo yêu cầu của bạn
  let currentLang = localStorage.getItem('aju-eq-lang') || 'en';

  // Thực thi dịch toàn bộ giao diện ngay khi mở bảng
  updateAjuLanguage(shadowRoot, currentLang);

  // Lắng nghe sự kiện click nút để đổi ngôn ngữ nhanh chóng
  if (langToggle) {
    langToggle.addEventListener('click', () => {
      currentLang = currentLang === 'en' ? 'vi' : 'en';
      updateAjuLanguage(shadowRoot, currentLang);
    });
  }
  // ---------------------------------------------------

  initAjuUiInteractions(shadowRoot);
}

function initAjuUiInteractions(root) {
  // --- CÁC BIẾN & SELECTOR ---
  const sliders = root.querySelectorAll('.aju-v-slider');
  const modeToggle = root.querySelector('#aju-mode-toggle');
  const simpleBox = root.querySelector('#aju-simple-sliders');
  const proBox = root.querySelector('#aju-pro-sliders');
  const modeText = root.querySelector('#mode-text');
  const profileSelect = root.querySelector('#aju-saved-profiles');
  const profileNameInput = root.querySelector('#aju-profile-name');
  const saveBtn = root.querySelector('#aju-save-btn');
  const exportBtn = root.querySelector('#aju-export-btn');
  const importBtn = root.querySelector('#aju-import-btn');
  const deleteBtn = root.querySelector('#aju-delete-btn');
  const fileInput = root.querySelector('#aju-file-input');
  // Thêm biến này vào đầu hàm initAjuUiInteractions
  const sliderCache = {};
  root.querySelectorAll('input[type="range"]').forEach(s => sliderCache[s.id] = s);
  // HỆ THỐNG AUDIO: dùng chung AudioContext/analyser của engine pitch chính (jungle.js)
  // qua cầu nối window.__getSharedFrequencyBins()/__resumeSharedAudioContext(), KHÔNG tự
  // tạo AudioContext + createMediaElementSource riêng nữa (1 <video> chỉ được gắn đúng 1
  // MediaElementAudioSourceNode trong suốt vòng đời, tạo lần 2 sẽ luôn ném InvalidStateError
  // và khiến analyser riêng không bao giờ nhận được dữ liệu âm thanh thật).
  // HÀM RESUME AN TOÀN (Bất tử với Chrome + mọi trình duyệt)
  function safeResumeAudioContext() {
    if (typeof window.__resumeSharedAudioContext === 'function') {
      window.__resumeSharedAudioContext();
    }
  }
  const HARDCODED_PRESETS = {
    PRESET_NIGHT_MODE: {
      isPro: true,
      values: {
        "aju-p-31": -6.0,
        "aju-p-62": -4.0,
        "aju-p-125": -2.0,
        "aju-p-250": 0.0,
        "aju-p-500": 1.5,
        "aju-p-1k": 2.0,
        "aju-p-2k": 1.5,
        "aju-p-4k": -1.0,
        "aju-p-8k": -2.5,
        "aju-p-16k": -4.0,
        "aju-master-gain": 1.0
      }
    },
    KARAOKE_PRO_REVERB: {
      isPro: true,
      values: {
        "aju-p-31": -4.5,
        "aju-p-62": -2.0,
        "aju-p-125": 1.0,
        "aju-p-250": 2.0,
        "aju-p-500": 1.5,
        "aju-p-1k": 3.5,
        "aju-p-2k": 4.5,
        "aju-p-4k": 2.5,
        "aju-p-8k": 1.5,
        "aju-p-16k": 2.0,
        "aju-master-gain": -2.0
      }
    },
    KARAOKE_DUET_WARMTH: {
      isPro: false,
      values: {
        "aju-s-bass": 1.5,
        "aju-s-mid": 3.0,
        "aju-s-vocal": 3.5,
        "aju-s-treble": 1.0,
        "aju-s-air": 1.5,
        "aju-master-gain": -1.5
      }
    },
    KARAOKE_REMIX_BOOST: {
      isPro: true,
      values: {
        "aju-p-31": 3.0,
        "aju-p-62": 5.5,
        "aju-p-125": 2.5,
        "aju-p-250": 0.0,
        "aju-p-500": -2.0,
        "aju-p-1k": 1.5,
        "aju-p-2k": 3.0,
        "aju-p-4k": 3.5,
        "aju-p-8k": 2.5,
        "aju-p-16k": 1.5,
        "aju-master-gain": -3.5
      }
    },
    PRESET_EDM: {
      isPro: false,
      values: {
        "aju-s-bass": 6.5,
        "aju-s-mid": -2.5,
        "aju-s-vocal": 1.0,
        "aju-s-treble": 4.0,
        "aju-s-air": 3.5,
        "aju-master-gain": -4.0
      }
    },
    PRESET_BALLAD: {
      isPro: false,
      values: {
        "aju-s-bass": 2.0,
        "aju-s-mid": 1.0,
        "aju-s-vocal": 4.5,
        "aju-s-treble": 2.5,
        "aju-s-air": 3.0,
        "aju-master-gain": -2.0
      }
    },
    PRESET_VOCAL_PRO: {
      isPro: true,
      values: {
        "aju-p-31": -3.0,
        "aju-p-62": -1.5,
        "aju-p-125": 0.5,
        "aju-p-250": 1.5,
        "aju-p-500": 2.0,
        "aju-p-1k": 4.0,
        "aju-p-2k": 4.5,
        "aju-p-4k": 3.0,
        "aju-p-8k": 1.5,
        "aju-p-16k": 1.0,
        "aju-master-gain": -2.0
      }
    },
    PRESET_CINEMA: {
      isPro: true,
      values: {
        "aju-p-31": 5.0,
        "aju-p-62": 3.5,
        "aju-p-125": 1.5,
        "aju-p-250": -1.5,
        "aju-p-500": 0.0,
        "aju-p-1k": 1.0,
        "aju-p-2k": 2.0,
        "aju-p-4k": 3.0,
        "aju-p-8k": 4.0,
        "aju-p-16k": 5.0,
        "aju-master-gain": -3.5
      }
    },
    PRESET_ROCK: {
      isPro: true,
      values: {
        "aju-p-31": 1.5,
        "aju-p-62": 4.5,
        "aju-p-125": 3.0,
        "aju-p-250": 0.5,
        "aju-p-500": -1.5,
        "aju-p-1k": 1.5,
        "aju-p-2k": 2.5,
        "aju-p-4k": 3.5,
        "aju-p-8k": 2.5,
        "aju-p-16k": 1.0,
        "aju-master-gain": -2.5
      }
    },
    PRESET_ACOUSTIC: {
      isPro: false,
      values: {
        "aju-s-bass": 0.5,
        "aju-s-mid": 2.0,
        "aju-s-vocal": 3.5,
        "aju-s-treble": 4.5,
        "aju-s-air": 4.0,
        "aju-master-gain": -2.0
      }
    },
    PRESET_CLASSIC: {
      isPro: true,
      values: {
        "aju-p-31": 1.5,
        "aju-p-62": 1.0,
        "aju-p-125": 0.5,
        "aju-p-250": 0.0,
        "aju-p-500": 0.5,
        "aju-p-1k": 0.0,
        "aju-p-2k": 1.0,
        "aju-p-4k": 1.5,
        "aju-p-8k": 2.0,
        "aju-p-16k": 2.5,
        "aju-master-gain": -1.0
      }
    },
    PRESET_LOFI: {
      isPro: false,
      values: {
        "aju-s-bass": 4.0,
        "aju-s-mid": 2.5,
        "aju-s-vocal": 1.0,
        "aju-s-treble": -2.0,
        "aju-s-air": -3.5,
        "aju-master-gain": -1.0
      }
    }
  };
  let aiIntervalId = null;

  function showToast(text, type = 'success') {
    const container = root.querySelector('#aju-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `aju-toast ${type}`;
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 2500);
    }, 2200);
  }
  // === UI EVENTS ===
  modeToggle?.addEventListener('change', () => {
    safeResumeAudioContext(); // ← Quan trọng
    if (modeToggle.checked) {
      simpleBox.classList.add('aju-hidden');
      proBox.classList.remove('aju-hidden');
      modeText.textContent = 'Pro DSP Mode';
    } else {
      proBox.classList.add('aju-hidden');
      simpleBox.classList.remove('aju-hidden');
      modeText.textContent = 'Simple Mode';
    }
    sendParamsToEngine();
  });
  let rafId = null;
  sliders.forEach(slider => {
    slider.addEventListener('input', (e) => {
      safeResumeAudioContext(); // ← Quan trọng
      if (e.target.id !== 'aju-master-gain') {
        if (typeof stopAI === 'function') stopAI();
        if (profileSelect && profileSelect.value && profileSelect.value.startsWith('AI_')) {
          profileSelect.value = "";
        }
      }
      updateBubble(e.target);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(sendParamsToEngine);
    });
  });

  function updateBubble(sliderElement) {
    const bubble = root.querySelector('#' + sliderElement.id.replace('aju-', 'val-'));
    if (bubble) {
      const val = parseFloat(sliderElement.value);
      bubble.textContent = val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1);
    }
  }

  function sendParamsToEngine(isReset = false) {
    const staticPayload = {
      source: 'AJU_UI_BRIDGE',
      offsets: {},
      simple: {},
      pro: {},
      // FIX: nút "Reset Mặc Định" chỉ đưa thanh trượt về 0, nhưng lớp dyn.* (tự động điều chỉnh theo
      // năng lượng phổ thời gian thực, độc lập với thanh trượt) bên jungle.js vẫn tiếp tục chạy - nghe
      // "eo eo" vì chưa thật sự về đúng 0 tuyệt đối như tên nút. Gắn cờ để jungle.js biết cần xoá luôn
      // lớp dyn.* khi đây là lệnh Reset.
      isReset
    };
    // Giữ nguyên logic vòng lặp cũ của bạn
    sliders.forEach(s => {
      if (s.id !== 'aju-master-gain') {
        staticPayload.offsets[s.id] = parseFloat(s.value);
      }
    });
    staticPayload.mode = modeToggle.checked ? 'pro' : 'simple';
    // SỬA CHỖ NÀY: Dùng sliderCache['id'] thay vì root.querySelector('#id')
    staticPayload.masterGain = parseFloat(sliderCache['aju-master-gain']?.value || 0);
    // Simple mode
    staticPayload.simple.bass = parseFloat(sliderCache['aju-s-bass']?.value || 0);
    staticPayload.simple.mid = parseFloat(sliderCache['aju-s-mid']?.value || 0);
    staticPayload.simple.vocal = parseFloat(sliderCache['aju-s-vocal']?.value || 0);
    staticPayload.simple.treble = parseFloat(sliderCache['aju-s-treble']?.value || 0);
    staticPayload.simple.air = parseFloat(sliderCache['aju-s-air']?.value || 0);
    // Pro mode
    staticPayload.pro.p31 = parseFloat(sliderCache['aju-p-31']?.value || 0);
    staticPayload.pro.p62 = parseFloat(sliderCache['aju-p-62']?.value || 0);
    staticPayload.pro.p125 = parseFloat(sliderCache['aju-p-125']?.value || 0);
    staticPayload.pro.p250 = parseFloat(sliderCache['aju-p-250']?.value || 0);
    staticPayload.pro.p500 = parseFloat(sliderCache['aju-p-500']?.value || 0);
    staticPayload.pro.p1k = parseFloat(sliderCache['aju-p-1k']?.value || 0);
    staticPayload.pro.p2k = parseFloat(sliderCache['aju-p-2k']?.value || 0);
    staticPayload.pro.p4k = parseFloat(sliderCache['aju-p-4k']?.value || 0);
    staticPayload.pro.p8k = parseFloat(sliderCache['aju-p-8k']?.value || 0);
    staticPayload.pro.p16k = parseFloat(sliderCache['aju-p-16k']?.value || 0);
    window.postMessage(staticPayload, '*');
  }

  function lerp(current, target, factor = 0.12) {
    return parseFloat(current) + (parseFloat(target) - parseFloat(current)) * factor;
  }

  function stopAI() {
    if (aiIntervalId) {
      clearInterval(aiIntervalId);
      aiIntervalId = null;
    }
  }

  function startAI(type) {
    stopAI();
    showToast(`Kích hoạt siêu ma trận AI: ${type.replace('AI_', '').replace('_', ' ')}`, 'success');
    // SỬA LỖI: Thay thế root.getElementById
    const masterSlider = root.querySelector('#aju-master-gain');
    const masterGainMap = {
      'AI_Karaoke_Live': 0.0,
      'AI_Perfect_Balance': 0.5,
      'AI_Auto_Genre': -0.5,
      'AI_Vocal_Follower': 0.2,
      'AI_EDM_Energy': 0.3
    };
    if (masterSlider) {
      masterSlider.value = masterGainMap[type] || 0.0;
      updateBubble(masterSlider);
    }
    // FIX ("chọn AI này rồi chọn AI khác có bị cộng dồn không"): trước đây presetSnapshot đọc thẳng
    // GIÁ TRỊ HIỆN TẠI của thanh trượt - đổi preset liên tục không bấm Reset ở giữa sẽ cộng delta preset
    // mới lên TRÊN vị trí preset cũ để lại, lệch dần khỏi đúng bản chất preset đang chọn. Luôn bắt đầu
    // mỗi preset từ nền 0 sạch - mỗi lần chọn AI đều tính như vừa bấm Reset rồi chọn preset đó.
    const presetSnapshot = {};
    sliders.forEach(s => {
      if (s.id !== 'aju-master-gain') {
        presetSnapshot[s.id] = 0.0;
      }
    });
    const isPro = ['AI_Karaoke_Live', 'AI_Perfect_Balance', 'AI_EDM_Energy'].includes(type);
    modeToggle.checked = isPro;
    simpleBox.classList.toggle('aju-hidden', isPro);
    proBox.classList.toggle('aju-hidden', !isPro);
    modeText.textContent = isPro ? 'Pro DSP Mode' : 'Simple Mode';
    // NÂNG CẤP ("AI phải biết cấu hình ngoài đang thế nào để trừ giảm hoặc tăng, không phải cái nào
    // cũng tăng"): bản cũ chỉ trích 3 dải thô (bass/mid/treble) từ 128 bin ĐẦU (~0-3kHz), cộng thêm
    // getJitter() (nhiễu ngẫu nhiên) và slowLFO/fastLFO (sóng cố định, lặp đều - "nhảy theo quán tính"),
    // và MỌI số hạng cộng thêm đều CỐ ĐỊNH, không biết cấu hình chính (Smart/bassHeavy/...) đã tự đẩy
    // dải đó lên sẵn bao nhiêu - cứ cộng đều, dễ đẩy quá đà (đặc biệt treble/air). Đổi sang: (1) trích
    // ĐỦ 7 dải theo đúng tỉ lệ tần số thật (đọc SAU KHI cấu hình chính đã xử lý xong, nên phản ánh đúng
    // những gì đang thực phát ra); (2) làm mịn theo thời gian (EMA) thay cho nhiễu ngẫu nhiên; (3)
    // "signedGate" cho presence/treble/air - CÓ THỂ ÂM: dải càng thấp thì AI càng cộng thêm, dải càng
    // cao (đã dư thật) thì AI CHỦ ĐỘNG TRỪ xuống, không chỉ dừng cộng - đúng nghĩa biết "trừ giảm hoặc
    // tăng" tuỳ tình trạng thật, không phải lúc nào cũng tăng.
    let smoothSubBass = 0.5, smoothBass = 0.5, smoothLowMid = 0.5, smoothMid = 0.5, smoothPresence = 0.5, smoothTreble = 0.5, smoothAir = 0.5;
    // "Phổ chuẩn" riêng của bài đang phát (trung bình dài hạn ~5s của từng dải) — xem NÂNG CẤP bên dưới.
    let longTerm = null;
    aiIntervalId = setInterval(() => {
      const audioEl = document.querySelector('video, audio');
      if (!audioEl || audioEl.paused) return;
      const bins = typeof window.__getSharedFrequencyBins === 'function' ? window.__getSharedFrequencyBins() : null;
      let realSubBass = 0.5, realBass = 0.5, realLowMid = 0.5, realMid = 0.5, realPresence = 0.5, realTreble = 0.5, realAir = 0.5;
      if (bins && bins.length) {
        const NYQUIST = 22050; // Xấp xỉ đúng cho hầu hết sampleRate phổ biến (44100/48000)
        const bandEnergy = (fLow, fHigh) => {
          const iLow = Math.max(0, Math.floor((fLow / NYQUIST) * bins.length));
          const iHigh = Math.min(bins.length, Math.ceil((fHigh / NYQUIST) * bins.length));
          if (iHigh <= iLow) return 0;
          let sum = 0;
          for (let i = iLow; i < iHigh; i++) sum += bins[i];
          return (sum / (iHigh - iLow)) / 255;
        };
        realSubBass = bandEnergy(20, 60);
        realBass = bandEnergy(60, 250);
        realLowMid = bandEnergy(250, 500);
        realMid = bandEnergy(500, 2000);
        realPresence = bandEnergy(2000, 4000);
        realTreble = bandEnergy(4000, 8000);
        realAir = bandEnergy(8000, 16000);
      }
      const emaAlpha = 0.35;
      smoothSubBass += (realSubBass - smoothSubBass) * emaAlpha;
      smoothBass += (realBass - smoothBass) * emaAlpha;
      smoothLowMid += (realLowMid - smoothLowMid) * emaAlpha;
      smoothMid += (realMid - smoothMid) * emaAlpha;
      smoothPresence += (realPresence - smoothPresence) * emaAlpha;
      smoothTreble += (realTreble - smoothTreble) * emaAlpha;
      smoothAir += (realAir - smoothAir) * emaAlpha;
      realSubBass = smoothSubBass; realBass = smoothBass; realLowMid = smoothLowMid;
      realMid = smoothMid; realPresence = smoothPresence; realTreble = smoothTreble; realAir = smoothAir;
      // NÂNG CẤP (hết "mid nhiều / bay bổng"): trước đây MỌI dải (31Hz lẫn 16kHz) bị so với CÙNG 1 ngưỡng
      // tuyệt đối 0.30-0.60. Nhưng phổ nhạc thật tự nhiên dốc xuống theo tần số (bass đo ~0.6-0.8, 4k-16k
      // chỉ ~0.15-0.35 — bình thường, không phải thiếu) → AI luôn tưởng cao thiếu (đẩy 2k/4k/8k/16k lên) và
      // bass dư (cắt bass) → mỏng, chói, "bay". Giờ mỗi dải so với MỨC TRUNG BÌNH DÀI HẠN CỦA CHÍNH NÓ trong
      // bài đang phát: AI chỉ sửa chỗ LỆCH khỏi bình thường của bài đó (dư thì cắt, thiếu thì bù). Các
      // hàm gate phía dưới giữ nguyên, chỉ nhận mức "tương đối".
      if (!longTerm) {
        longTerm = { subBass: realSubBass, bass: realBass, lowMid: realLowMid, mid: realMid, presence: realPresence, treble: realTreble, air: realAir };
      }
      const ltAlpha = 0.012; // ~5 giây ở nhịp 60ms
      longTerm.subBass += (realSubBass - longTerm.subBass) * ltAlpha;
      longTerm.bass += (realBass - longTerm.bass) * ltAlpha;
      longTerm.lowMid += (realLowMid - longTerm.lowMid) * ltAlpha;
      longTerm.mid += (realMid - longTerm.mid) * ltAlpha;
      longTerm.presence += (realPresence - longTerm.presence) * ltAlpha;
      longTerm.treble += (realTreble - longTerm.treble) * ltAlpha;
      longTerm.air += (realAir - longTerm.air) * ltAlpha;
      // Lệch 0.1 (~7dB theo thang byte của analyser) so với mức bình thường của bài = tác động tối đa.
      // Điểm "bình thường" đặt ở 0.40 (hơi dưới tâm 0.45 của signedGate) → khi bài đang đúng mức bình
      // thường, AI vẫn tạo hình nhẹ ~1/3 cường độ, ĐỀU cho mọi dải (giữ chất riêng của từng preset AI);
      // dải thiếu → bù mạnh hơn, dải dư → tự cắt.
      const relLevel = (cur, base) => 0.40 + (cur - base) * 1.5;
      const relSubBass = relLevel(realSubBass, longTerm.subBass);
      const relBass = relLevel(realBass, longTerm.bass);
      const relLowMid = relLevel(realLowMid, longTerm.lowMid);
      const relMid = relLevel(realMid, longTerm.mid);
      const relPresence = relLevel(realPresence, longTerm.presence);
      const relTreble = relLevel(realTreble, longTerm.treble);
      const relAir = relLevel(realAir, longTerm.air);
      const currentTime = audioEl.currentTime || 0;
      const duration = audioEl.duration || 180;
      const progress = Math.min(Math.max(currentTime / duration, 0), 1);
      const getSoftFactor = (start, end) => {
        if (progress < start || progress > end) return 0;
        const x = (progress - start) / (end - start);
        return Math.sin(x * Math.PI);
      };
      const introFactor = getSoftFactor(0.00, 0.18);
      const buildupFactor = getSoftFactor(0.12, 0.35);
      const verseFactor = getSoftFactor(0.20, 0.48);
      const chorusFactor = getSoftFactor(0.40, 0.88);
      const bridgeFactor = getSoftFactor(0.72, 0.82);
      let deltas = {};
      let isRealDrop = false;
      // bandGate: tắt dần lệnh CẮT cố định (bass/mud/mid) khi dải đó đang THIẾU thật - không cắt thêm
      // vào chỗ đã thiếu. Chỉ còn dùng cho 3 dải "khoét chỗ cho mic" cố ý một chiều trong Karaoke Live
      // (subBass/lowMid/mid) - mọi dải khác đã chuyển hết sang signedGate 2 chiều (xem NÂNG CẤP dưới).
      const bandGate = (level, floor = 0.15, ceil = 0.45) => Math.min(1, Math.max(0, (level - floor) / (ceil - floor)));
      const subBassGate = bandGate(relSubBass);
      const lowMidGate = bandGate(relLowMid);
      const midGate = bandGate(relMid);
      // signedGate: dùng riêng cho presence/treble/air - CÓ THỂ ÂM (chủ động cắt khi dải đã dư thật,
      // không chỉ giảm cộng thêm về 0). Áp dụng cho cả 5 preset, không riêng EDM nữa.
      // FIX ("chọn Smart vẫn còn chói"): mid=0.525 (low=0.35/high=0.70) quá cao so với mức treble mà
      // Smart đã đẩy sẵn khi phát nhạc bình thường - phần lớn thời gian vẫn rơi vào vùng "còn thấp hơn
      // trung tâm" nên vẫn cộng thêm thay vì cắt. Hạ mid xuống 0.45 (low=0.30/high=0.60) - nhạy hơn,
      // bắt đầu chủ động cắt sớm hơn ngay khi treble đã ở mức trung bình-cao, không cần đợi tới rất cao.
      const signedGate = (level, low = 0.30, high = 0.60) => {
        const mid = (low + high) / 2;
        const span = (high - low) / 2;
        return Math.max(-1, Math.min(1, (mid - level) / span));
      };
      const presSigned = signedGate(relPresence);
      const trebleSigned = signedGate(relTreble);
      const airSigned = signedGate(relAir);
      // NÂNG CẤP ("làm 2 chiều HẾT, phải thông minh biết cái nào lớn quá thì cắt, cân bằng cho âm
      // thanh hay - người dùng không rành mới chọn AI, AI phải tự lo cho hay"): trước đây CHỈ presence/
      // treble/air/mid(EDM p500,p1k) đi qua signedGate (biết cả cắt lẫn cộng). Còn subBass/bass/lowMid/
      // mid ở phần lớn preset khác vẫn dùng bandGate/richnessGate - CHỈ GIẢM DẦN lượng cộng về gần 0
      // khi dải đã dày, KHÔNG BAO GIỜ thật sự cắt xuống - đặc biệt preset "Perfect Balance" (Cân Bằng)
      // toàn bộ 6 dải bass/mid đều chỉ cộng, không dải nào biết cắt, nên gặp nhạc đã sẵn nhiều bass/mid
      // thì vẫn cứ cộng thêm vào chỗ đã đầy, đúng thứ gây đục/ù dù tên preset là "Cân Bằng". Thêm đủ bộ
      // signedGate cho cả subBass/bass/lowMid/mid để MỌI dải, MỌI preset đều 2 chiều thật sự.
      const subBassSigned = signedGate(relSubBass);
      const bassSigned = signedGate(relBass);
      const lowMidSigned = signedGate(relLowMid);
      const midSigned = signedGate(relMid);
      if (type === 'AI_Karaoke_Live') {
        // TRIẾT LÝ: Siết chặt Bass trống giữ nhịp, Dọn sạch dải ù (250Hz), Khoét lỗ dải Trung (1k-2k) cho Mic, Đẩy căng dải Siêu Cao tạo "Màu Tươi".
        deltas = {
          'aju-p-31': (-1.5 * chorusFactor * subBassGate) - (realSubBass * 1.8),
          // NÂNG CẤP: p62 (kick bass, "giữ nhịp") trước đây chỉ CỘNG (bassRich chỉ giảm dần lượng cộng
          // về gần 0, không bao giờ cắt) - nhạc đã nhiều bass sẵn vẫn cứ cộng thêm, gây ù/vỡ. Đổi sang
          // bassSigned: bass còn thiếu thì cộng theo đúng nhịp bài (intro/buildup/chorus), bass đã dư
          // thật thì tự cắt bớt thay vì cộng mù quáng.
          'aju-p-62': ((0.6 * introFactor) + (1.0 * buildupFactor) + (2.2 * chorusFactor) + (realBass * 3.0)) * bassSigned,
          // NÂNG CẤP: gộp 2 cơ chế cũ (cắt cố định qua bassGate + cộng qua bassRich, có thể triệt tiêu
          // nhau vô nghĩa) thành 1 công thức bassSigned duy nhất, nhất quán với mọi dải khác.
          'aju-p-125': ((verseFactor * 0.3) + (chorusFactor * 0.5) + (realBass * 0.8)) * bassSigned,
          'aju-p-250': (-1.0 * verseFactor * lowMidGate) - (1.6 * chorusFactor * lowMidGate) - (realLowMid * 2.0),
          'aju-p-500': (-0.4 * verseFactor * midGate) - (0.9 * chorusFactor * midGate) - (realMid * 0.7) + (introFactor * 0.3),
          'aju-p-1k': (0.5 * introFactor) - (0.4 * verseFactor * midGate) - (0.9 * chorusFactor * midGate) - (realPresence * 0.8),
          'aju-p-2k': ((0.3 * buildupFactor) + (0.8 * verseFactor) + (1.5 * chorusFactor)) * presSigned,
          'aju-p-4k': ((0.3 * introFactor) + (0.8 * chorusFactor) + (realTreble * 1.6)) * trebleSigned,
          'aju-p-8k': ((1.0 * verseFactor) + (2.2 * chorusFactor) + (realTreble * 2.6)) * trebleSigned,
          'aju-p-16k': ((1.3 * introFactor) + (3.0 * chorusFactor) + (realAir * 3.6)) * airSigned
        };
      } else if (type === 'AI_Perfect_Balance') {
        const activeDrive = (verseFactor * 0.5) + (chorusFactor * 0.8);
        // NÂNG CẤP ("Cân Bằng mà sao không dải nào biết cắt"): cả 6 dải bass/mid ở đây trước đây CHỈ
        // CỘNG (richnessGate chỉ hãm dần về gần 0 khi dải đã dày, không bao giờ thật sự cắt) - đúng
        // ngược với ý nghĩa "Cân Bằng". Đổi cả 6 dải sang *Signed: dải đang thiếu thì cộng cho đủ, dải
        // đã dư thật thì chủ động cắt bớt - mới thực sự cân bằng theo đúng nội dung bài hát.
        deltas = {
          'aju-p-31': (0.4 + (realSubBass * 1.2)) * subBassSigned,
          'aju-p-62': (1.2 + (activeDrive * 0.5) + (realBass * 1.4)) * bassSigned,
          'aju-p-125': (0.8 + (realBass * 0.6)) * bassSigned,
          'aju-p-250': (0.4 + (realLowMid * 0.6)) * lowMidSigned,
          'aju-p-500': (0.2 + (realMid * 0.4)) * midSigned,
          'aju-p-1k': (0.8 + (realMid * 0.7)) * midSigned,
          'aju-p-2k': (1.4 + (activeDrive * 0.5) + (realPresence * 1.0)) * presSigned,
          'aju-p-4k': (1.2 + (realTreble * 0.8)) * trebleSigned,
          'aju-p-8k': (1.6 + (realTreble * 1.2)) * trebleSigned,
          'aju-p-16k': (1.8 + (realAir * 1.4)) * airSigned
        };
      } else if (type === 'AI_Auto_Genre') {
        const isBassHeavySong = realBass > 0.55 || realSubBass > 0.55;
        const isBassLightSong = realBass < 0.30 && realSubBass < 0.30;
        // NÂNG CẤP: s-bass (cả 2 nhánh) trước đây chỉ CỘNG (bassRich/subBassRich chỉ hãm dần, không
        // cắt) - đổi sang bassSigned/subBassSigned để tự cắt khi bài đã sẵn nhiều bass thật, tránh dội/
        // vỡ tiếng ở các bài bass-heavy. s-mid nhánh "nhẹ" cũng đổi sang midSigned cho nhất quán; s-mid
        // nhánh bass-heavy giữ nguyên (chủ ý khoét mid nhường chỗ cho bass/sub, đã tỉ lệ theo thực tế).
        deltas = (isBassHeavySong || (chorusFactor > 0.3 && !isBassLightSong)) ? {
          'aju-s-bass': (3.0 + (realBass * 2.2) + (realSubBass * 1.0)) * bassSigned,
          'aju-s-mid': -0.6 - (realLowMid * 0.5),
          'aju-s-vocal': (1.0 + (realPresence * 1.2)) * presSigned,
          'aju-s-treble': (2.0 + (realTreble * 1.5)) * trebleSigned,
          'aju-s-air': (1.8 + (realAir * 1.0)) * airSigned
        } : {
          'aju-s-bass': (1.2 + (realBass * 1.0)) * bassSigned,
          'aju-s-mid': (0.8 + (realMid * 0.6)) * midSigned,
          'aju-s-vocal': (2.4 + (realPresence * 1.8)) * presSigned + (realMid * 0.8),
          'aju-s-treble': (1.2 + (realTreble * 0.8)) * trebleSigned,
          'aju-s-air': (1.4 + (realAir * 0.8)) * airSigned
        };
      } else if (type === 'AI_Vocal_Follower') {
        // NÂNG CẤP: s-bass/s-mid trước đây "0.6 - realBass*0.8" gần như luôn dương (chỉ âm khi
        // realBass > 0.75, hiếm khi xảy ra thực tế) - phản ứng rất yếu. Đổi sang bassSigned/
        // lowMidSigned để nhường mic (dọn bớt bass/mid thật sự khi 2 dải này đã dày) chính xác hơn
        // theo đúng nội dung bài hát, không chỉ giảm nhẹ như trước.
        deltas = {
          'aju-s-vocal': ((1.0 * introFactor) + (2.0 * verseFactor) + (3.0 * chorusFactor) + (realPresence * 3.5)) * presSigned + (realMid * 1.0),
          'aju-s-bass': 0.6 * bassSigned,
          'aju-s-mid': 0.5 * lowMidSigned,
          'aju-s-treble': (1.6 + (realTreble * 1.2)) * trebleSigned,
          'aju-s-air': (1.8 + (realAir * 1.2)) * airSigned
        };
      } else if (type === 'AI_EDM_Energy') {
        const dropRamp = Math.min(1, Math.max(0, (Math.max(realBass, realSubBass) - 0.55) / (0.75 - 0.55)));
        isRealDrop = dropRamp > 0.5;
        // NÂNG CẤP: p31/p62/p125/p250 trước đây chỉ CỘNG (subBassRich/bassRich/lowMidRich chỉ hãm dần
        // về gần 0, không cắt) - đổi phần "nền" (buildup/chorus/verse + real-band) sang *Signed để tự
        // cắt khi dải đã dư thật, chống ù. RIÊNG phần dropRamp (bùng bass lúc "drop") giữ TÁCH RIÊNG,
        // KHÔNG nhân qua *Signed - vì đó là đặc trưng cốt lõi của EDM (bass PHẢI bùng mạnh đúng lúc
        // drop dù lúc đó bass đang rất to), nhân qua Signed sẽ tự triệt tiêu đúng lúc cần bùng nhất.
        deltas = {
          'aju-p-31': ((buildupFactor * 1.5) + (chorusFactor * 3.5) + (realSubBass * 2.5)) * subBassSigned + (dropRamp * 1.0),
          'aju-p-62': ((buildupFactor * 1.4) + (chorusFactor * 3.0) + (realBass * 2.2)) * bassSigned + (dropRamp * 0.8),
          'aju-p-125': ((verseFactor * 0.8) + (chorusFactor * 1.6) + (realBass * 0.8)) * bassSigned,
          'aju-p-250': ((buildupFactor * 1.5) + (chorusFactor * 1.2) + (realLowMid * 0.6)) * lowMidSigned,
          'aju-p-500': ((verseFactor * 0.8) + (chorusFactor * 1.4)) * midSigned - (dropRamp * 1.2),
          'aju-p-1k': ((chorusFactor * 2.0) + (realMid * 1.0)) * midSigned,
          'aju-p-2k': ((buildupFactor * 1.4) + (chorusFactor * 3.2) + (realPresence * 2.0)) * presSigned,
          'aju-p-4k': ((chorusFactor * 2.8) + (bridgeFactor * 1.0) + (realTreble * 1.0)) * trebleSigned,
          'aju-p-8k': ((chorusFactor * 2.4) + (realTreble * 2.0)) * trebleSigned,
          'aju-p-16k': ((chorusFactor * 2.6) + (realAir * 2.4)) * airSigned
        };
      }
      // NÂNG CẤP: AI chỉ "đánh bóng" trên nền cấu hình ngoài, không vẽ lại âm thanh — mỗi dải tối đa
      // ±3 dB (lớp EQ giờ áp đúng 1:1 dB). Riêng bass lúc "drop" của AI EDM cho phép lên +4 dB.
      Object.keys(deltas).forEach(key => {
        const maxUp = (type === 'AI_EDM_Energy' && (key === 'aju-p-31' || key === 'aju-p-62')) ? 4.0 : 3.0;
        const v = Number.isFinite(deltas[key]) ? deltas[key] : 0;
        deltas[key] = Math.max(-3.0, Math.min(maxUp, v));
      });
      // ==================== DYNAMIC COMPENSATOR & LERP ====================
      let totalDeltaEnergy = 0;
      Object.keys(deltas).forEach(key => {
        totalDeltaEnergy += Math.abs(deltas[key]);
      });
      const attenuationFactor = totalDeltaEnergy > 15 ? 15 / totalDeltaEnergy : 1.0;
      let activeLerpFactor = 0.12;
      if (type === 'AI_EDM_Energy' || type === 'AI_Karaoke_Live') {
        activeLerpFactor = isRealDrop ? 0.35 : 0.24;
      }
      // TỐI ƯU: Lặp qua Cache thay vì query lại DOM
      Object.keys(sliderCache).forEach(id => {
        if (id === 'aju-master-gain') return;
        const s = sliderCache[id];
        const basePresetVal = presetSnapshot[id] !== undefined ? presetSnapshot[id] : 0;
        const dynamicDelta = deltas[id] !== undefined ? deltas[id] : 0;
        const boundedTarget = Math.min(Math.max(basePresetVal + (dynamicDelta * attenuationFactor), -12.0), 12.0);
        s.value = lerp(s.value, boundedTarget, activeLerpFactor).toFixed(1);
        updateBubble(s);
      });
      sendParamsToEngine();
    }, 60);
  }

  function updateProfileDropdown(userProfiles, selectedName) {
    if (!profileSelect) return;
    // SỬA LỖI: Thay thế root.getElementById
    const userGroup = root.querySelector('#user-profiles-group');
    if (userGroup) userGroup.innerHTML = '';
    for (const name in userProfiles) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (userGroup) userGroup.appendChild(opt);
    }
    if (selectedName) profileSelect.value = selectedName;
  }

  // Preset hệ thống (PRESET_*/KARAOKE_*) vốn thiết kế như EQ độc lập ±4-6.5 dB, nhưng giờ nằm TRÊN 8
  // cấu hình vốn đã có EQ riêng → áp ở 60% cường độ để không chồng quá tay. Cấu hình người dùng tự lưu
  // vẫn áp đúng 100% giá trị đã lưu.
  const SYSTEM_PRESET_INTENSITY = 0.6;
  function applyConfigToSliders(config, intensity = 1) {
    if (!config) return;
    stopAI();
    // Reset sạch trước khi apply preset mới (fix dính)
    sliders.forEach(function(s) {
      if (s.id !== 'aju-master-gain') s.value = 0;
    });
    // SỬA LỖI: Thay thế root.getElementById
    const master = root.querySelector('#aju-master-gain');
    if (master) master.value = 0;
    if (modeToggle) modeToggle.checked = config.isPro || false;
    if (config.isPro) {
      simpleBox?.classList.add('aju-hidden');
      proBox?.classList.remove('aju-hidden');
      if (modeText) modeText.textContent = 'Pro DSP Mode';
    } else {
      proBox?.classList.add('aju-hidden');
      simpleBox?.classList.remove('aju-hidden');
      if (modeText) modeText.textContent = 'Simple Mode';
    }
    // Apply giá trị preset
    for (const id in config.values) {
      // SỬA LỖI: Thay thế root.getElementById
      const slider = root.querySelector('#' + id);
      if (slider) {
        slider.value = (parseFloat(config.values[id]) * intensity).toFixed(1);
        updateBubble(slider);
      }
    }
    sendParamsToEngine();
    showToast('Đã áp dụng preset', 'success');
  }
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['aju_profiles', 'aju_active_profile'], (res) => {
      const userProfiles = res.aju_profiles || {};
      updateProfileDropdown(userProfiles, res.aju_active_profile);
      const activeName = res.aju_active_profile;
      if (activeName) {
        if (activeName.startsWith('AI_')) {
          if (profileSelect) profileSelect.value = activeName;
          startAI(activeName);
        } else if (HARDCODED_PRESETS[activeName]) {
          if (profileSelect) profileSelect.value = activeName;
          applyConfigToSliders(HARDCODED_PRESETS[activeName], SYSTEM_PRESET_INTENSITY);
        } else if (userProfiles[activeName]) {
          if (profileSelect) profileSelect.value = activeName;
          applyConfigToSliders(userProfiles[activeName]);
        }
      }
    });
  }
  profileSelect?.addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) {
      stopAI();
      return;
    }
    // === MỞ KHÓA WEB AUDIO API QUA TƯƠNG TÁC NGƯỜI DÙNG (dùng chung AudioContext của engine chính) ===
    safeResumeAudioContext();
    // ====================================================
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        aju_active_profile: name
      });
      if (name.startsWith('AI_')) {
        startAI(name);
      } else if (HARDCODED_PRESETS[name]) {
        stopAI(); // Dừng Interval AI nếu người dùng chuyển về Preset tĩnh
        applyConfigToSliders(HARDCODED_PRESETS[name], SYSTEM_PRESET_INTENSITY);
      } else {
        stopAI(); // Dừng Interval AI nếu người dùng chuyển về Profile cá nhân tĩnh
        chrome.storage.local.get(['aju_profiles'], (res) => {
          const userProfiles = res.aju_profiles || {};
          if (userProfiles[name]) {
            applyConfigToSliders(userProfiles[name]);
          }
        });
      }
    }
  });
  saveBtn?.addEventListener('click', () => {
    const name = profileNameInput ? profileNameInput.value.trim() : '';
    if (!name) return showToast('Vui lòng điền tên cấu hình!', 'warning');
    if (name.startsWith('AI_') || HARDCODED_PRESETS[name]) return showToast('Tên này trùng với Preset hệ thống!', 'warning');
    const currentValues = {};
    sliders.forEach(s => currentValues[s.id] = parseFloat(s.value));
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['aju_profiles'], (res) => {
        const profiles = res.aju_profiles || {};
        profiles[name] = {
          isPro: modeToggle ? modeToggle.checked : false,
          values: currentValues
        };
        chrome.storage.local.set({
          aju_profiles: profiles,
          aju_active_profile: name
        }, () => {
          updateProfileDropdown(profiles, name);
          if (profileNameInput) profileNameInput.value = '';
          showToast(`Đã lưu cấu hình cá nhân "${name}"!`, 'success');
        });
      });
    }
  });
  deleteBtn?.addEventListener('click', () => {
    const name = profileSelect ? profileSelect.value : '';
    if (!name) return showToast('Hãy chọn cấu hình cần xóa!', 'warning');
    if (name.startsWith('AI_') || HARDCODED_PRESETS[name]) return showToast('Không thể xóa cấu hình mặc định hệ thống!', 'danger');
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['aju_profiles'], (res) => {
        const profiles = res.aju_profiles || {};
        if (profiles[name]) {
          delete profiles[name];
          chrome.storage.local.set({
            aju_profiles: profiles,
            aju_active_profile: ''
          }, () => {
            updateProfileDropdown(profiles, '');
            showToast(`Đã xóa sạch cấu hình cá nhân "${name}"!`, 'danger');
            root.querySelector('#aju-reset-btn')?.click();
          });
        }
      });
    }
  });
  exportBtn?.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['aju_profiles'], (res) => {
        const dataStr = JSON.stringify(res.aju_profiles || {}, null, 2);
        const blob = new Blob([dataStr], {
          type: 'application/json'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'AJU_Equalizer_Backup.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Đã xuất file sao lưu JSON!', 'success');
      });
    }
  });
  importBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const importedProfiles = JSON.parse(event.target.result);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(['aju_profiles'], (res) => {
            const existing = res.aju_profiles || {};
            const merged = {
              ...existing,
              ...importedProfiles
            };
            chrome.storage.local.set({
              aju_profiles: merged
            }, () => {
              updateProfileDropdown(merged, '');
              showToast('Đã nhập tệp cấu hình JSON thành công!', 'success');
            });
          });
        }
      } catch (err) {
        showToast('Tệp lỗi, sai định dạng JSON cấu hình!', 'danger');
      }
    };
    reader.readAsText(file);
  });
  // ==================== RESET TOÀN BỘ EQ - SIÊU SẠCH (FIX DÍNH) ====================
  function resetAllSliders() {
    stopAI();
    sliders.forEach(function(slider) {
      slider.value = 0;
      updateBubble(slider);
    });
    const masterSlider = root.querySelector('#aju-master-gain');
    if (masterSlider) {
      masterSlider.value = 0;
      updateBubble(masterSlider);
    }
    if (modeToggle) modeToggle.checked = false;
    if (simpleBox && proBox) {
      simpleBox.classList.remove('aju-hidden');
      proBox.classList.add('aju-hidden');
    }
    if (modeText) modeText.textContent = 'Simple Mode';
    if (profileSelect) profileSelect.value = "";
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        aju_active_profile: ''
      });
    }
    if (typeof staticPayload !== 'undefined') {
      staticPayload.offsets = {};
      staticPayload.simple = {};
      staticPayload.pro = {};
      staticPayload.masterGain = 0;
      staticPayload.mode = 'simple';
    }
    sendParamsToEngine(true);
    showToast('Đã Reset toàn bộ EQ về mặc định (0.0 dB) - SẠCH HOÀN TOÀN', 'success');
  }
  // Gắn sự kiện cho nút Reset
  const resetBtn = root.querySelector('#aju-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetAllSliders);
  }
  // Close button
  const closeBtn = () => {
    root.querySelector('#aju-modal-overlay')?.classList.remove('is-visible');
  };
  root.querySelector('#aju-close')?.addEventListener('click', closeBtn);
}
// HÀM CHUYỂN ĐỔI NGÔN NGỮ TỐC ĐỘ CAO KHÔNG TỐN TÀI NGUYÊN CPU (ĐÃ CẬP NHẬT DỊCH OPTIONS)
function updateAjuLanguage(shadowRoot, lang) {
  localStorage.setItem('aju-eq-lang', lang);
  const isVi = lang === 'vi';

  const langBtnSpan = shadowRoot.getElementById('aju-lang-toggle')?.querySelector('span');
  if (langBtnSpan) langBtnSpan.textContent = isVi ? 'VI' : 'EN';

  // 1. Dịch các thành phần giao diện tĩnh
  const translationMap = {
    'aju-profile-name': isVi ? 'Tên tùy chỉnh...' : 'Custom name...',
    'aju-export-btn': isVi ? 'Xuất JSON' : 'Export JSON',
    'aju-import-btn': isVi ? 'Nhập JSON' : 'Import JSON',
    'aju-save-btn': isVi ? 'Lưu Lại' : 'Save Profile',
    'aju-delete-btn': isVi ? 'Xóa Bản Lưu' : 'Delete Saved',
    'aju-reset-btn': isVi ? 'Reset Mặc Định' : 'Reset Default'
  };

  for (const [id, value] of Object.entries(translationMap)) {
    const el = shadowRoot.getElementById(id);
    if (el) {
      if (el.tagName === 'INPUT') el.placeholder = value;
      else el.textContent = value;
    }
  }

  // Đồng bộ lại text Mode hiện tại theo ngôn ngữ mới
  const modeToggle = shadowRoot.getElementById('aju-mode-toggle');
  const modeText = shadowRoot.getElementById('mode-text');
  if (modeText && modeToggle) {
    modeText.textContent = modeToggle.checked ? 'Pro Mode' : 'Simple Mode';
  }

  // 2. Dịch chú thích (Tooltip / Title) của các thanh gạt
  const slidersData = {
    's-bass': isVi ? 'Dải trầm (60-250Hz): Tăng lực đánh và độ đầm cho trống kick, bassline.' : 'Low frequencies (60-250Hz): Boost punch and depth for kick drum, bassline.',
    's-mid': isVi ? 'Dải trung (250-2kHz): Độ dày và ấm cho nhạc cụ, thân giọng hát.' : 'Mid range (250-2kHz): Thickness and warmth for instruments, vocal body.',
    's-vocal': isVi ? 'Dải trung cao (2-6kHz): Tăng độ rõ ràng và nổi bật của giọng hát.' : 'Upper mid (2-6kHz): Increase clarity and prominence of vocals.',
    's-treble': isVi ? 'Dải cao (6-12kHz): Độ sáng, chi tiết của guitar, cymbal, hi-hat.' : 'High range (6-12kHz): Brightness, detail of guitar, cymbal, hi-hat.',
    's-air': isVi ? 'Siêu cao (12kHz+): Không gian mở, thoáng, độ tơi và ánh sáng tự nhiên.' : 'Super high (12kHz+): Open space, airiness, texture and natural light.',
    'p-31': isVi ? 'Sub-bass: Độ rung sâu, lực bass ngầm, cảm giác uy lực.' : 'Sub-bass: Deep rumble, sub-bass power, majestic feeling.',
    'p-62': isVi ? 'Kick & Bass Weight: Độ đầm, chắc của trống kick và bassline.' : 'Kick & Bass Weight: Fullness, tightness of kick drum and bassline.',
    'p-125': isVi ? 'Bass Body: Độ ấm và đầy đặn của dải bass.' : 'Bass Body: Warmth and fullness of the bass range.',
    'p-250': isVi ? 'Low-Mid: Giảm độ đục, tăng độ rõ cho guitar và giọng hát.' : 'Low-Mid: Reduce muddiness, increase clarity for guitar and vocals.',
    'p-500': isVi ? 'Mid Low: Độ dày, ấm của giọng hát (đặc biệt giọng nam).' : 'Mid Low: Thickness, warmth of vocals (especially male voice).',
    'p-1k': isVi ? 'Mid Presence: Độ rõ ràng của ca từ và trung tâm âm thanh.' : 'Mid Presence: Clarity of lyrics and center of sound.',
    'p-2k': isVi ? 'Upper Mid: Độ nổi bật, "đẩy" giọng hát lên phía trước.' : 'Upper Mid: Prominence, "pushing" vocals to the front.',
    'p-4k': isVi ? 'Presence & Attack: Độ sắc nét của nhạc cụ, attack của trống.' : 'Presence & Attack: Crispness of instruments, drum attack.',
    'p-8k': isVi ? 'Treble: Độ sáng, chi tiết cao, âm gió (s, sh, ch).' : 'Treble: Brightness, high detail, sibilance (s, sh, ch).',
    'p-16k': isVi ? 'Air & Brilliance: Không gian mở, độ lấp lánh và thoáng đãng.' : 'Air & Brilliance: Open space, sparkling and airy atmosphere.',
    'master-gain': isVi ? 'Âm lượng tổng (Master Gain): Điều tiết biên độ lớn nhỏ tổng thể sau bộ lọc.' : 'Master volume (Master Gain): Overall gain control after filtering.'
  };

  for (const [id, desc] of Object.entries(slidersData)) {
    const inputEl = shadowRoot.getElementById(`aju-${id}`);
    if (inputEl) {
      const wrapper = inputEl.closest('.aju-track-wrapper');
      if (wrapper) wrapper.title = desc;
    }
  }

  // 3. XỬ LÝ DỊCH HOÀN TOÀN MENU LỰA CHỌN (Bao gồm nhóm danh mục và tất cả Option con)
  const selectEl = shadowRoot.getElementById('aju-saved-profiles');
  if (selectEl) {
    // Dịch tiêu đề dòng đầu tiên
    selectEl.options[0].textContent = isVi ? '-- Chọn cấu hình xử lý --' : '-- Select processing profile --';

    // Dịch tiêu đề các Nhóm danh mục (Optgroup)
    const groups = selectEl.getElementsByTagName('optgroup');
    if (groups.length >= 4) {
      groups[0].label = isVi ? '✨ Siêu Thuật Toán AI Tự Động (Real-time)' : '✨ Super AI Auto Algorithms (Real-time)';
      groups[1].label = isVi ? '🎤 Cấu Hình Đặc Chủng Hát Karaoke Studio' : '🎤 Special Studio Karaoke Config';
      groups[2].label = isVi ? '🎹 Nhà Thiết Kế Kỹ Sư Pro Preset' : '🎹 Engineer Pro Preset Designers';
	  groups[3].label = isVi ? '💾 Cấu Hình Người Dùng Lưu' : '💾 Saved User Configurations';
    }

    // Bản đồ dịch chi tiết cho từng Option con dựa trên thuộc tính Value
    const optionsData = {
      'AI_Perfect_Balance': isVi ? '🤖 [AI] Smart Perfect Balance (Toàn Năng)' : '🤖 [AI] Smart Perfect Balance (All-Rounder)',
      'AI_Auto_Genre': isVi ? '🎵 [AI] Intelligent Genre Flower' : '🎵 [AI] Intelligent Genre Adaptive',
      'AI_Vocal_Follower': isVi ? '🎤 [AI] Auto Vocal Clarity Master' : '🎤 [AI] Auto Vocal Clarity Master',
      'AI_Karaoke_Live': isVi ? '🎤 [AI] Real-time Dynamic Karaoke Adaptive' : '🎤 [AI] Real-time Dynamic Karaoke Adaptive',
      'AI_EDM_Energy': isVi ? '🔥 [AI] EDM Energy Drop Master' : '🔥 [AI] EDM Energy Drop Master',

      'KARAOKE_PRO_REVERB': isVi ? '✨ Karaoke Studio Cao Cấp - Trợ Lực Thoát Tiếng' : '✨ Premium Studio Karaoke - Vocal Assist',
      'KARAOKE_DUET_WARMTH': isVi ? '❤️ Karaoke Giọng Nam/Nữ - Ấm Áp Dày Dặn' : '❤️ Male/Female Duet - Warm & Rich Tone',
      'KARAOKE_REMIX_BOOST': isVi ? '⚡ Karaoke Nhạc Sàn Remix - Trống Lực Giọng Sáng' : '⚡ Remix Floor Music - Punchy Bass & Bright Vocal',

      'PRESET_EDM': isVi ? '🔥 EDM & Dance - Siêu Bass Lực' : '🔥 EDM & Dance - Super Bass Boost',
      'PRESET_BALLAD': isVi ? '🎵 Pop & Ballad - Rõ Lời Ngọt Ngào' : '🎵 Pop & Ballad - Sweet & Clear Vocals',
      'PRESET_VOCAL_PRO': isVi ? '🎙️ Vocal Boost Pro - Sáng Trung Cao' : '🎙️ Vocal Boost Pro - Bright Mid-High',
      'PRESET_CINEMA': isVi ? '🎬 Cinema Surround - Hiệu Ứng Rạp Phim' : '🎬 Cinema Surround - Movie Theater Effects',
      'PRESET_ROCK': isVi ? '⚡ Rock & Metal - Đậm Khối Năng Lượng' : '⚡ Rock & Metal - High Energy Solid Tone',
      'PRESET_ACOUSTIC': isVi ? '🎸 Acoustic - Tách Lớp Nhạc Cụ' : '🎸 Acoustic - Clear Instrument Separation',
      'PRESET_CLASSIC': isVi ? '🎻 Classical - Cân Bằng Chi Tiết' : '🎻 Classical - Detailed Balance',
      'PRESET_LOFI': isVi ? '☕ Lo-Fi Chill - Ấm Áp Hoài Niệm' : '☕ Lo-Fi Chill - Warm Nostalgia'
    };

    // Vòng lặp duyệt qua toàn bộ các option hiện có trong select để dịch tự động siêu tốc
    const options = selectEl.getElementsByTagName('option');
    for (let i = 0; i < options.length; i++) {
      const val = options[i].value;
      if (optionsData[val]) {
        options[i].textContent = optionsData[val];
      }
    }
  }
}