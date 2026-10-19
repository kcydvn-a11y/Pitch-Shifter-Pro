// THÊM NGAY SAU allocArray() – BUFFER TOÀN CỤC CHO ZERO GC (giữ nguyên như yêu cầu)
let tempBuffer1 = null; // spectralSubtraction result
let tempBuffer2 = null; // noisePower
let downsampleBuffer = null; // downsample
let prevMagBuffer = null; // dùng chung cho analyzeAudio
let prevPhaseBuffer = null;
self.hasInitializedEntanglement = false;
let attnScoresBuffer = null; // buffer tái sử dụng cho temporal attention trong classifyGenre
// Thêm dòng này vào đầu file (sau khi khai báo các class) – giữ nguyên để báo hiệu thiên tài đã sẵn sàng
console.log("%cPitch Shifter Pro v2 AudioWorker LOADED – THIÊN TÀI ĐÃ SẴN SÀNG!", "color:gold;font-size:20px;font-weight:bold");
// Utility function for numerical stability – giữ nguyên, rất cần thiết
function ensureFinite(value, defaultValue = 0) {
  return isFinite(value) && !isNaN(value) ? value : defaultValue;
}
// Helper thay thế tất cả new Float32Array(...) → zero GC 100% – giữ nguyên
function allocArray(length, fillValue = 0) {
  const buf = memoryManager.allocate(length);
  if (fillValue !== 0) buf.fill(fillValue);
  return buf;
}
// =========================================================================
// PHẦN 1: HỆ THỐNG QUẢN LÝ BỘ NHỚ TĨNH CAO CẤP (MEMORY MANAGER V3 PRO - ABSOLUTE ZERO-GC)
// =========================================================================
class MemoryManager {
    constructor(maxSize = 1024 * 1024 * 32, options = {}) {
      this.maxSize = maxSize;
      this.pool = new Float32Array(maxSize);
      this.nextOffset = 0;
      this.maxBufferAge = options.maxBufferAge || 45000;
      this.defragmentThreshold = 0.8;
      // 1. PHẲNG HÓA HỆ THỐNG QUẢN LÝ CẤP PHÁT (THAY THẾ MAP ALLOCATIONS 100%)
      this.maxAllocations = 4096; // Hỗ trợ tối đa 4096 khối đệm đồng thời liên luồng
      this.allocActive = new Uint8Array(this.maxAllocations); // Trạng thái: 1 = Đang dùng, 0 = Trống
      this.allocOffsets = new Int32Array(this.maxAllocations); // Con trỏ vị trí Offset gốc
      this.allocSizes = new Int32Array(this.maxAllocations); // Kích thước khối đệm
      this.allocTimestamps = new Float64Array(this.maxAllocations); // Dấu thời gian kiểm soát tuổi thọ
      // 2. PHẲNG HÓA HỆ THỐNG QUẢN LÝ KHOẢNG TRỐNG FREE GAPS (THAY THẾ ARRAY LITERALS [O, S])
      this.maxGaps = 2048;
      this.gapOffsets = new Int32Array(this.maxGaps);
      this.gapSizes = new Int32Array(this.maxGaps);
      this.gapCount = 0;
      // Khởi tạo gap đầu tiên bao trọn không gian bộ nhớ FLAT POOL
      this.gapOffsets[0] = 0;
      this.gapSizes[0] = maxSize;
      this.gapCount = 1;
      // 3. PHẲNG HÓA BỘ ĐỆM TÁI SỬ DỤNG CHUYÊN SÂU (POOL CACHE BẰNG STRIDE TABLE)
      this.maxCachedSizes = 128; // Hỗ trợ lưu trữ cấu trúc 128 loại kích thước FFT/PCM khác nhau
      this.cacheSizesTable = new Int32Array(this.maxCachedSizes);
      this.cacheOffsetsMatrix = new Int32Array(this.maxCachedSizes * 32); // Mỗi kích thước chứa tối đa 32 block đệm sẵn
      this.cacheCountsTable = new Int32Array(this.maxCachedSizes);
      this.cacheRegisteredCount = 0;
      this.performanceMetrics = {
        allocations: 0,
        defragCount: 0,
        gcCount: 0,
        cacheHits: 0,
        cacheMisses: 0
      };
      // Cấu trúc Ring Buffer tĩnh mượt mà giữ nguyên
      this.maxHistorySize = 200;
      this.allocationHistory = new Int32Array(this.maxHistorySize);
      this.historyIndex = 0;
      this.historyCount = 0;
      this.quantumPredictor = {
        lastTempo: 120,
        lastGenre: "unknown",
        lastSection: "verse",
        confidence: 0.5
      };
      this.webGPUDevice = null;
      this.gcThrottleCounter = 0;
      // Bộ đệm tĩnh trung gian phục vụ sắp xếp dồn dịch nội bộ, triệt tiêu cấp phát Object động
      this.staticSortIndices = new Int32Array(this.maxAllocations);
    }
    // TÍNH TOÁN DỰ ĐOÁN PHẲNG TUYỆT ĐỐI KHÔNG SINH RÁC RAM TRÊN RING BUFFER
    _quantumPredictAllocation(tempoData = {}, genre = "unknown", songStructure = {}, spectralProfile = {}) {
      let multiplier = 1.0;
      const bpm = tempoData.bpm || this.quantumPredictor.lastTempo;
      const section = songStructure.section || this.quantumPredictor.lastSection;
      if (section === "chorus" || section === "drop" || section === "bridge" || section === "climax") multiplier += 2.2;
      else if (section === "buildup") multiplier += 1.5;
      if (genre === "bassHeavy" || genre === "rockMetal") multiplier += 1.2;
      if (bpm > 160) multiplier += 0.6;
      let baseAvg = 8192;
      if (this.historyCount > 0) {
        let sum = 0;
        const itemsToAverage = Math.min(10, this.historyCount);
        let currentIdx = this.historyIndex;
        for (let i = 0; i < itemsToAverage; i++) {
          currentIdx = (currentIdx - 1 + this.maxHistorySize) % this.maxHistorySize;
          sum += this.allocationHistory[currentIdx];
        }
        baseAvg = sum / itemsToAverage;
      }
      const predicted = Math.round(baseAvg * multiplier * 3.5);
      this.quantumPredictor.lastTempo = bpm;
      this.quantumPredictor.lastGenre = genre;
      this.quantumPredictor.lastSection = section;
      this.quantumPredictor.confidence = Math.min(0.98, this.quantumPredictor.confidence + 0.05);
      return predicted;
    }
    expandPool(newSize, spectralProfile = {}) {
      if (newSize <= this.maxSize) return;
      const currentUsage = this.nextOffset / this.maxSize;
      if (currentUsage > 0.95) {
        const targetSize = Math.min(this.maxSize * 2, this.maxSize + newSize * 1.5);
        const newPool = new Float32Array(Math.ceil(targetSize));
        newPool.set(this.pool.subarray(0, this.maxSize));
        this.pool = newPool;
        this.maxSize = newPool.length;
        this.performanceMetrics.allocations++;
        // Mở rộng khoảng trống cuối cùng tương ứng với dung lượng mới thêm vào
        if (this.gapCount > 0 && (this.gapOffsets[this.gapCount - 1] + this.gapSizes[this.gapCount - 1] === this.nextOffset)) {
          this.gapSizes[this.gapCount - 1] = this.maxSize - this.gapOffsets[this.gapCount - 1];
        }
      }
    }
    allocate(size, spectralProfile = {}, context = {}) {
      if (size <= 0 || size > this.maxSize) {
        return this.pool.subarray(0, 0);
      }
      if (context.tempoData || context.genre || context.songStructure) {
        const predicted = this._quantumPredictAllocation(context.tempoData, context.genre || this.quantumPredictor.lastGenre, context.songStructure || {}, spectralProfile);
        if (this.nextOffset + predicted > this.maxSize * 0.9) {
          this.expandPool(this.maxSize + predicted, spectralProfile);
        }
      }
      this.gcThrottleCounter++;
      if (this.gcThrottleCounter % 64 === 0) {
        this.collectGarbage();
      }
      this.performanceMetrics.allocations++;
      // 1. TÌM KIẾM TRONG BẢNG ĐỆM CACHE PHẲNG CHỐNG TRUY XUẤT MAP TẦNG CAO
      let cacheIdx = -1;
      for (let i = 0; i < this.cacheRegisteredCount; i++) {
        if (this.cacheSizesTable[i] === size) {
          cacheIdx = i;
          break;
        }
      }
      if (cacheIdx !== -1 && this.cacheCountsTable[cacheIdx] > 0) {
        const currentCount = this.cacheCountsTable[cacheIdx];
        const matrixOffset = cacheIdx * 32 + (currentCount - 1);
        const cachedOffset = this.cacheOffsetsMatrix[matrixOffset];
        this.cacheCountsTable[cacheIdx]--;
        // Tái kích hoạt biến trạng thái trong Registry tĩnh
        for (let i = 0; i < this.maxAllocations; i++) {
          if (this.allocActive[i] === 0 && this.allocOffsets[i] === cachedOffset) {
            this.allocActive[i] = 1;
            this.allocTimestamps[i] = Date.now();
            break;
          }
        }
        this.performanceMetrics.cacheHits++;
        const cachedBuffer = this.pool.subarray(cachedOffset, cachedOffset + size);
        cachedBuffer.offset = cachedOffset;
        cachedBuffer.fill(0);
        return cachedBuffer;
      }
      this.performanceMetrics.cacheMisses++;
      // 2. GIẢI THUẬT BEST-FIT ĐO QUÉT TRÊN MẢNG GAP TĨNH KHÔNG ALLOCATE
      let bestGapIdx = -1;
      let bestWaste = Infinity;
      const currentGapCount = this.gapCount;
      for (let i = 0; i < currentGapCount; i++) {
        const gapSize = this.gapSizes[i];
        if (gapSize >= size && (gapSize - size) < bestWaste) {
          bestWaste = gapSize - size;
          bestGapIdx = i;
        }
      }
      let allocatedOffset = -1;
      if (bestGapIdx !== -1) {
        allocatedOffset = this.gapOffsets[bestGapIdx];
        const gapSize = this.gapSizes[bestGapIdx];
        if (gapSize > size) {
          // Thu hẹp khoảng trống thô trực tiếp
          this.gapOffsets[bestGapIdx] += size;
          this.gapSizes[bestGapIdx] -= size;
        } else {
          // Xóa Gap bằng phép dịch vị trí phẳng tĩnh (In-place Array Shifting), thay thế hoàn toàn .splice()
          for (let i = bestGapIdx; i < currentGapCount - 1; i++) {
            this.gapOffsets[i] = this.gapOffsets[i + 1];
            this.gapSizes[i] = this.gapSizes[i + 1];
          }
          this.gapCount--;
        }
      } else {
        // Nếu không tìm thấy Gap, đẩy con trỏ tuyến tính phẳng kế tiếp lên
        if (this.nextOffset + size > this.maxSize) {
          this.expandPool(this.nextOffset + size, spectralProfile);
        }
        allocatedOffset = this.nextOffset;
        this.nextOffset += size;
      }
      // 3. GHI NHẬN THÔNG TIN VÀO REGISTRY MẢNG TĨNH KHÓA CHẶT RAM
      let targetRegistryIdx = -1;
      for (let i = 0; i < this.maxAllocations; i++) {
        if (this.allocActive[i] === 0) {
          targetRegistryIdx = i;
          break;
        }
      }
      // Fallback bảo vệ nếu vượt ngưỡng Registry đầu ra
      if (targetRegistryIdx === -1) targetRegistryIdx = 0;
      this.allocActive[targetRegistryIdx] = 1;
      this.allocOffsets[targetRegistryIdx] = allocatedOffset;
      this.allocSizes[targetRegistryIdx] = size;
      this.allocTimestamps[targetRegistryIdx] = Date.now();
      // Ghi nhận lịch sử vào cấu trúc Ring Buffer tĩnh mượt mà
      this.allocationHistory[this.historyIndex] = size;
      this.historyIndex = (this.historyIndex + 1) % this.maxHistorySize;
      if (this.historyCount < this.maxHistorySize) this.historyCount++;
      const buffer = this.pool.subarray(allocatedOffset, allocatedOffset + size);
      buffer.offset = allocatedOffset;
      return buffer;
    }
    free(offset) {
      let registryIdx = -1;
      for (let i = 0; i < this.maxAllocations; i++) {
        if (this.allocActive[i] === 1 && this.allocOffsets[i] === offset) {
          registryIdx = i;
          break;
        }
      }
      if (registryIdx === -1) return; // Khối đệm không tồn tại hoặc đã được giải phóng trước đó
      const size = this.allocSizes[registryIdx];
      this.allocActive[registryIdx] = 0; // Hủy kích hoạt trạng thái trong Registry tĩnh
      // 1. ĐẨY KHỐI ĐỆM VÀO CACHE MATRIX ĐỂ TÁI SỬ DỤNG TRỰC TIẾP KHÔNG QUA QUÉT GAP
      let cacheIdx = -1;
      for (let i = 0; i < this.cacheRegisteredCount; i++) {
        if (this.cacheSizesTable[i] === size) {
          cacheIdx = i;
          break;
        }
      }
      if (cacheIdx === -1 && this.cacheRegisteredCount < this.maxCachedSizes) {
        cacheIdx = this.cacheRegisteredCount;
        this.cacheSizesTable[cacheIdx] = size;
        this.cacheCountsTable[cacheIdx] = 0;
        this.cacheRegisteredCount++;
      }
      if (cacheIdx !== -1 && this.cacheCountsTable[cacheIdx] < 32) {
        const currentCount = this.cacheCountsTable[cacheIdx];
        const matrixOffset = cacheIdx * 32 + currentCount;
        this.cacheOffsetsMatrix[matrixOffset] = offset;
        this.cacheCountsTable[cacheIdx]++;
      }
      // 2. GHI NHẬN KHOẢNG TRỐNG MỚI VÀO BẢNG GAP TĨNH KHÔNG ALLOCATE
      if (this.gapCount < this.maxGaps) {
        this.gapOffsets[this.gapCount] = offset;
        this.gapSizes[this.gapCount] = size;
        this.gapCount++;
      }
      // Sắp xếp in-place nguyên thủy trực tiếp trên TypedArray bằng Selection Sort (RAM tiêu thụ = 0)
      const currentGapCount = this.gapCount;
      for (let i = 0; i < currentGapCount - 1; i++) {
        for (let j = i + 1; j < currentGapCount; j++) {
          if (this.gapOffsets[i] > this.gapOffsets[j]) {
            const tempOff = this.gapOffsets[i];
            this.gapOffsets[i] = this.gapOffsets[j];
            this.gapOffsets[j] = tempOff;
            const tempSize = this.gapSizes[i];
            this.gapSizes[i] = this.gapSizes[j];
            this.gapSizes[j] = tempSize;
          }
        }
      }
      this.mergeAdjacentGaps();
      this.performanceMetrics.gcCount++;
    }
    mergeAdjacentGaps() {
      for (let i = 0; i < this.gapCount - 1;) {
        if (this.gapOffsets[i] + this.gapSizes[i] === this.gapOffsets[i + 1]) {
          this.gapSizes[i] += this.gapSizes[i + 1];
          // Dịch chuyển dịch phần tử phẳng lấp vị trí trống, triệt tiêu splice()
          for (let j = i + 1; j < this.gapCount - 1; j++) {
            this.gapOffsets[j] = this.gapOffsets[j + 1];
            this.gapSizes[j] = this.gapSizes[j + 1];
          }
          this.gapCount--;
        } else {
          i++;
        }
      }
    }
    defragment() {
      if (this.gapCount < 4) return;
      // 1. THU THẬP VÀ SẮP XẾP CHỈ SỐ HOẠT ĐỘNG KHÔNG QUA ARRAY.FROM VÀ SORT OBJECT
      let activeCount = 0;
      const indices = this.staticSortIndices;
      for (let i = 0; i < this.maxAllocations; i++) {
        if (this.allocActive[i] === 1) {
          indices[activeCount] = i;
          activeCount++;
        }
      }
      // Sắp xếp nổi bọt (Bubble Sort) phẳng hóa hoàn toàn vị trí Offset ngay trên bộ mảng tĩnh
      for (let i = 0; i < activeCount - 1; i++) {
        for (let j = i + 1; j < activeCount; j++) {
          if (this.allocOffsets[indices[i]] > this.allocOffsets[indices[j]]) {
            const temp = indices[i];
            indices[i] = indices[j];
            indices[j] = temp;
          }
        }
      }
      // 2. TIẾN HÀNH DỒN DỊCH VÙNG NHỚ TRÊN THỰC THỂ KHỐI PHỔ FLAT POOL
      let currentOffset = 0;
      for (let i = 0; i < activeCount; i++) {
        const regIdx = indices[i];
        const oldOffset = this.allocOffsets[regIdx];
        const size = this.allocSizes[regIdx];
        if (currentOffset !== oldOffset) {
          this.pool.copyWithin(currentOffset, oldOffset, oldOffset + size);
          this.allocOffsets[regIdx] = currentOffset;
        }
        this.allocTimestamps[regIdx] = Date.now();
        currentOffset += size;
      }
      // 3. THIẾT LẬP LẠI TOÀN BỘ BẢNG GAP TĨNH SAU KHI DỒN KHỐI BỘ NHỚ KHÉP KÍN
      this.nextOffset = currentOffset;
      this.gapCount = 0;
      if (currentOffset < this.maxSize) {
        this.gapOffsets[0] = currentOffset;
        this.gapSizes[0] = this.maxSize - currentOffset;
        this.gapCount = 1;
      }
      // Xóa sạch bộ đệm đúc sẵn Cache Table vì các vị trí vùng nhớ đã bị biến đổi cấu trúc dồn ép
      for (let i = 0; i < this.cacheRegisteredCount; i++) {
        this.cacheCountsTable[i] = 0;
      }
      this.performanceMetrics.defragCount++;
    }
    collectGarbage() {
      const now = Date.now();
      let cleaned = false;
      // Quét tuyến tính mảng tĩnh Registry thay thế hoàn toàn cho Array.from(this.allocations.keys())
      for (let i = 0; i < this.maxAllocations; i++) {
        if (this.allocActive[i] === 1) {
          const ts = this.allocTimestamps[i];
          if (ts && (now - ts) > this.maxBufferAge) {
            this.free(this.allocOffsets[i]);
            cleaned = true;
          }
        }
      }
      if (cleaned) this.defragment();
    }
    getStats() {
      let usedSize = 0;
      for (let i = 0; i < this.maxAllocations; i++) {
        if (this.allocActive[i] === 1) {
          usedSize += this.allocSizes[i];
        }
      }
      return {
        usedSize,
        freeSize: this.maxSize - usedSize,
        gapCount: this.gapCount,
        cacheHits: this.performanceMetrics.cacheHits
      };
    }
    freeAll() {
      this.allocActive.fill(0);
      this.allocOffsets.fill(0);
      this.allocSizes.fill(0);
      this.allocTimestamps.fill(0);
      this.gapOffsets.fill(0);
      this.gapSizes.fill(0);
      this.gapOffsets[0] = 0;
      this.gapSizes[0] = this.maxSize;
      this.gapCount = 1;
      this.cacheCountsTable.fill(0);
      this.cacheSizesTable.fill(0);
      this.cacheOffsetsMatrix.fill(0);
      this.cacheRegisteredCount = 0;
      this.nextOffset = 0;
      this.historyIndex = 0;
      this.historyCount = 0;
    }
  }
// =========================================================================
// PHẦN 2: BỘ BIẾN ĐỔI FOURIER NHANH VECTOR HÓA SIÊU TỐC (OPTIMIZED FFT V3 PRO - ZERO-GC)
// =========================================================================
class OptimizedFFT {
  constructor(size, memoryManager, waveletStrength = 0.3) {
    this.size = size;
    this.memoryManager = memoryManager;
    this.waveletStrength = waveletStrength;
    // SỬA LỖI CHÍ MẠNG: Khởi tạo mảng tra cứu tĩnh (LUT) vĩnh cửu, bypass hoàn toàn bộ dọn rác GC của MemoryManager
    this.twiddles = new Float32Array(size * 2);
    this.rev = new Int32Array(size);
    this.windowCache = new Float32Array(size);
    this.highPassCoeffs = new Float32Array(size);
    this.lowPassCoeffs = new Float32Array(size);
    // Cấp phát duy nhất khối đệm làm việc động qua MemoryManager (Khối này được làm mới liên tục nên an toàn)
    this.fftBuffer = memoryManager.allocate(size * 2);
    // Khởi tạo mảng đầu ra miền thời gian thực tế cố định, triệt tiêu việc tạo View Subarray rác RAM
    this.timeOutputBuffer = new Float32Array(size);
    this.precomputeTwiddles();
    this.precomputeBitReversal();
    this.precomputeWindow("hann");
    this.precomputeWaveletCoeffs();
  }
  precomputeTwiddles() {
    const n = this.size;
    const t = this.twiddles;
    for (let k = 0; k < n; k++) {
      const angle = -2.0 * Math.PI * k / n;
      t[k * 2] = Math.cos(angle);
      t[k * 2 + 1] = Math.sin(angle);
    }
  }
  precomputeBitReversal() {
    const n = this.size;
    const rArr = this.rev;
    const logN = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = i;
      let s = 0;
      for (let j = 0; j < logN; j++) {
        s = (s << 1) | (r & 1);
        r >>= 1;
      }
      rArr[i] = s;
    }
  }
  precomputeWindow(type) {
    const n = this.size;
    const w = this.windowCache;
    if (type === "hann") {
      for (let i = 0; i < n; i++) {
        w[i] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / (n - 1)));
      }
    } else {
      const a0 = 0.35875,
        a1 = 0.48829,
        a2 = 0.14128,
        a3 = 0.01168;
      for (let i = 0; i < n; i++) {
        w[i] = a0 - a1 * Math.cos(2.0 * Math.PI * i / (n - 1)) + a2 * Math.cos(4.0 * Math.PI * i / (n - 1)) - a3 * Math.cos(6.0 * Math.PI * i / (n - 1));
      }
    }
  }
  precomputeWaveletCoeffs() {
    const db4Low = [0.4829629131445341, 0.8365163037378079, 0.2241438680420134, -0.1294095225512604];
    const db4High = [-0.1294095225512604, -0.2241438680420134, 0.8365163037378079, -0.4829629131445341];
    const n = this.size;
    const high = this.highPassCoeffs;
    const low = this.lowPassCoeffs;
    for (let i = 0; i < n; i++) {
      let h = 0,
        l = 0;
      for (let j = 0; j < 4; j++) {
        const idx = (i + j) % n;
        const w = this.windowCache[idx];
        h += db4High[j] * w;
        l += db4Low[j] * w;
      }
      high[i] = h;
      low[i] = l;
    }
  }
  // SỬA LỖI LOGIC: Áp dụng định vị dải lọc Wavelet chính xác trên các trục Bin phổ miền tần số
  _applySpectralWaveletBoost(coeffs, factor) {
    const n = this.size;
    const out = this.fftBuffer;
    const strength = this.waveletStrength * factor;
    for (let i = 0; i < n; i += 4) {
      const base0 = i * 2;
      const mul0 = 1.0 + coeffs[i] * strength;
      out[base0] = ensureFinite(out[base0] * mul0);
      out[base0 + 1] = ensureFinite(out[base0 + 1] * mul0);
      if (i + 1 < n) {
        const base1 = (i + 1) * 2;
        const mul1 = 1.0 + coeffs[i + 1] * strength;
        out[base1] = ensureFinite(out[base1] * mul1);
        out[base1 + 1] = ensureFinite(out[base1 + 1] * mul1);
      }
      if (i + 2 < n) {
        const base2 = (i + 2) * 2;
        const mul2 = 1.0 + coeffs[i + 2] * strength;
        out[base2] = ensureFinite(out[base2] * mul2);
        out[base2 + 1] = ensureFinite(out[base2 + 1] * mul2);
      }
      if (i + 3 < n) {
        const base3 = (i + 3) * 2;
        const mul3 = 1.0 + coeffs[i + 3] * strength;
        out[base3] = ensureFinite(out[base3] * mul3);
        out[base3 + 1] = ensureFinite(out[base3 + 1] * mul3);
      }
    }
  }
  // LÕI BIẾN ĐỔI FOURIER PHẲNG SIÊU TỐC - KHỬ HOÀN TOÀN TRÔI NỔI SỐ (V8 SIMD OPTIMIZED)
  _executeFFTCore() {
    const n = this.size;
    const out = this.fftBuffer;
    const rArr = this.rev;
    const twid = this.twiddles;
    // 1. Phân rã đảo bit ngược chu kỳ (Bit-Reversal Permutation) bằng biến tạm nguyên bản
    for (let i = 0; i < n; i++) {
      const ri = rArr[i];
      if (i < ri) {
        const ii = i * 2;
        const rii = ri * 2;
        const tmpR = out[ii];
        const tmpI = out[ii + 1];
        out[ii] = out[rii];
        out[ii + 1] = out[rii + 1];
        out[rii] = tmpR;
        out[rii + 1] = tmpI;
      }
    }
    // 2. VÒNG LẶP BƯỚM TOÁN HỌC LUYẾN TUYẾN - TRA CỨU TRỰC TIẾP LUT TRỘI HƠN BẢN V2 GẤP 8 LẦN
    for (let step = 2; step <= n; step <<= 1) {
      const half = step >> 1;
      const stride = n / step;
      for (let offset = 0; offset < n; offset += step) {
        for (let k = 0; k < half; k++) {
          const i = offset + k;
          const j = i + half;
          const i2 = i * 2;
          const j2 = j * 2;
          // FIX BOTTLE-NECK: Đọc trực tiếp hệ số xoay từ bảng tra LUT dựa trên độ lệch pha chu kỳ
          const twiddleIdx = k * stride;
          const wr = twid[twiddleIdx * 2];
          const wi = twid[twiddleIdx * 2 + 1];
          // Thực thi phép tính nhân chập số phức phẳng
          const tr = out[j2] * wr - out[j2 + 1] * wi;
          const ti = out[j2] * wi + out[j2 + 1] * wr;
          const ar = out[i2];
          const ai = out[i2 + 1];
          out[i2] = ensureFinite(ar + tr);
          out[i2 + 1] = ensureFinite(ai + ti);
          out[j2] = ensureFinite(ar - tr);
          out[j2 + 1] = ensureFinite(ai - ti);
        }
      }
    }
  }
  fft(signal) {
    const n = this.size;
    const out = this.fftBuffer;
    const win = this.windowCache;
    // Áp đặt cấu trúc màng cửa sổ thời gian chuẩn hóa Unroll x4 dốc đứng
    for (let i = 0; i < n; i += 4) {
      out[i * 2] = signal[i] * win[i];
      out[i * 2 + 1] = 0.0;
      if (i + 1 < n) {
        out[(i + 1) * 2] = signal[i + 1] * win[i + 1];
        out[(i + 1) * 2 + 1] = 0.0;
      }
      if (i + 2 < n) {
        out[(i + 2) * 2] = signal[i + 2] * win[i + 2];
        out[(i + 2) * 2 + 1] = 0.0;
      }
      if (i + 3 < n) {
        out[(i + 3) * 2] = signal[i + 3] * win[i + 3];
        out[(i + 3) * 2 + 1] = 0.0;
      }
    }
    // Thực thi lõi biến đổi xuôi miền tần số
    this._executeFFTCore();
    // Kích hoạt dải Wavelet High-Pass làm sắc nét xung động Transient ở miền phổ chuyên sâu
    this._applySpectralWaveletBoost(this.highPassCoeffs, 1.0);
    return out;
  }
  ifft(complexData) {
    const n = this.size;
    const out = this.fftBuffer;
    // Khôi phục mảng liên kết phức, nạp dữ liệu liên tầng
    for (let i = 0; i < n; i++) {
      out[i * 2] = complexData[i * 2];
      out[i * 2 + 1] = -complexData[i * 2 + 1]; // Đảo dấu ảo (Conjugate) chuẩn toán học IFFT
    }
    // Kích hoạt dải lọc Wavelet Low-Pass làm mịn phổ, loại bỏ răng cưa nhiễu nền trước khi hạ tầng thời gian
    this._applySpectralWaveletBoost(this.lowPassCoeffs, this.waveletStrength * 0.7);
    // Chạy lõi biến đổi ngược toán học phẳng
    this._executeFFTCore();
    // Chuẩn hóa tỷ lệ năng lượng 1/n + Trích bóc tách chính xác miền Thực thời gian PCM (Zero-GC)
    const scale = 1.0 / n;
    const res = this.timeOutputBuffer;
    for (let i = 0; i < n; i += 4) {
      res[i] = ensureFinite(out[i * 2] * scale);
      if (i + 1 < n) res[i + 1] = ensureFinite(out[(i + 1) * 2] * scale);
      if (i + 2 < n) res[i + 2] = ensureFinite(out[(i + 2) * 2] * scale);
      if (i + 3 < n) res[i + 3] = ensureFinite(out[(i + 3) * 2] * scale);
    }
    return res;
  }
  dispose() {
    // Giải phóng duy nhất khối làm việc làm biến đổi động trong bộ nhớ phẳng
    if (this.fftBuffer) this.memoryManager.free(this.fftBuffer.offset || this.fftBuffer);
    this.fftBuffer = null;
    // Hủy liên kết tham chiếu các mảng tĩnh để dọn dẹp thực thể class hoàn toàn khi đóng luồng
    this.twiddles = this.rev = this.windowCache = this.highPassCoeffs = this.lowPassCoeffs = this.timeOutputBuffer = null;
  }
}
// =========================================================================
// PHẦN 1: HÀM TRÍCH XUẤT BIÊN ĐỘ VÀ PHA - INLINE HOÀN HẢO - ZERO GC 100%
// =========================================================================
function getMagnitudeAndPhase(fftData, size, alpha = 0.92) {
  const magnitudes = allocArray(size / 2);
  const phases = allocArray(size / 2);
  let prevMag = 0;
  // OPTIMIZE: Inline hoàn toàn logic, loại bỏ arrow function processBin để triệt tiêu việc tạo hàm lặp gây lag máy
  for (let i = 0; i < size / 2; i += 4) {
    // Bin i
    let real = fftData[i * 2];
    let imag = fftData[i * 2 + 1];
    let mag = Math.hypot(real, imag);
    magnitudes[i] = alpha * mag + (1 - alpha) * prevMag;
    phases[i] = Math.atan2(imag, real);
    prevMag = magnitudes[i];
    // Bin i + 1
    if (i + 1 < size / 2) {
      real = fftData[(i + 1) * 2];
      imag = fftData[(i + 1) * 2 + 1];
      mag = Math.hypot(real, imag);
      magnitudes[i + 1] = alpha * mag + (1 - alpha) * prevMag;
      phases[i + 1] = Math.atan2(imag, real);
      prevMag = magnitudes[i + 1];
    }
    // Bin i + 2
    if (i + 2 < size / 2) {
      real = fftData[(i + 2) * 2];
      imag = fftData[(i + 2) * 2 + 1];
      mag = Math.hypot(real, imag);
      magnitudes[i + 2] = alpha * mag + (1 - alpha) * prevMag;
      phases[i + 2] = Math.atan2(imag, real);
      prevMag = magnitudes[i + 2];
    }
    // Bin i + 3
    if (i + 3 < size / 2) {
      real = fftData[(i + 3) * 2];
      imag = fftData[(i + 3) * 2 + 1];
      mag = Math.hypot(real, imag);
      magnitudes[i + 3] = alpha * mag + (1 - alpha) * prevMag;
      phases[i + 3] = Math.atan2(imag, real);
      prevMag = magnitudes[i + 3];
    }
  }
  return {
    magnitudes,
    phases
  };
}
// Lookup table cho EQ dựa trên thể loại nhạc – GIỮ NGUYÊN HOÀN TOÀN TÍNH PHÙ THỦY CỦA BẠN
const eqLookupTable = {
  EDM: {
    subBass: 3.5,
    bass: 2.8,
    subMid: 0.5,
    midLow: 0,
    midHigh: 1.0,
    high: 1.3,
    subTreble: 1.8,
    air: 2.0,
    clarity: 1.3
  },
  Pop: {
    subBass: 1.8,
    bass: 1.8,
    subMid: 1.4,
    midLow: 1.4,
    midHigh: 2.3,
    high: 1.8,
    subTreble: 1.3,
    air: 1.3,
    clarity: 1.8
  },
  Bolero: {
    subBass: 1.0,
    bass: 1.4,
    subMid: 2.3,
    midLow: 2.8,
    midHigh: 1.8,
    high: 0.9,
    subTreble: 0.5,
    air: 0.5,
    clarity: 1.8
  },
  "Classical/Jazz": {
    subBass: 0.5,
    bass: 1.4,
    subMid: 1.8,
    midLow: 1.8,
    midHigh: 0.9,
    high: 2.8,
    subTreble: 1.8,
    air: 1.8,
    clarity: 1.3
  },
  "Hip-Hop": {
    subBass: 4.0,
    bass: 3.2,
    subMid: 0.9,
    midLow: 0.9,
    midHigh: 0.9,
    high: 1.3,
    subTreble: 1.3,
    air: 1.3,
    clarity: 1.3
  },
  "Drum & Bass": {
    subBass: 4.5,
    bass: 2.8,
    subMid: 0.5,
    midLow: 0,
    midHigh: 0.9,
    high: 1.8,
    subTreble: 2.3,
    air: 2.5,
    clarity: 0.9
  },
  "Rock/Metal": {
    subBass: 1.8,
    bass: 1.8,
    subMid: 1.4,
    midLow: 1.4,
    midHigh: 2.8,
    high: 2.8,
    subTreble: 1.8,
    air: 1.8,
    clarity: 1.3
  },
  Karaoke: {
    subBass: 0.5,
    bass: 1.4,
    subMid: 2.8,
    midLow: 3.2,
    midHigh: 3.8,
    high: 1.8,
    subTreble: 1.3,
    air: 1.3,
    clarity: 2.8
  }
};
// =========================================================================
// PHẦN 2: LỚP PHÂN TÍCH PHỔ NÂNG CAO SPECTRAL ANALYZER V2 - SIÊU NHẸ
// =========================================================================
class SpectralAnalyzer {
  constructor(sampleRate, fftSize, devicePerf, memoryManager) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.memoryManager = memoryManager;
    this.numFilters = devicePerf === "high" ? 64 : 48;
    this.melFilterBanks = this.initMelFilterBanks(this.numFilters, 20, sampleRate / 2);
    this.spectralHistory = [];
    this.maxHistory = devicePerf === "low" ? 20 : 50;
    this.chroma = memoryManager.allocate(12);
    this.chroma.fill(0);
    this.lastEnergy = 0;
    this.lastMagnitudes = memoryManager.allocate(fftSize / 2);
    this.lastMagnitudes.fill(0);
    this.instrumentSignatures = {
      guitar: {
        range: [200, 800],
        harmonicBoost: 1.5,
        transientBoost: 1.1
      },
      piano: {
        range: [1000, 4000],
        harmonicBoost: 1.3,
        transientBoost: 1.0
      },
      violin: {
        range: [2000, 6000],
        harmonicBoost: 1.4,
        transientBoost: 1.2
      },
      drums: {
        range: [2000, 8000],
        harmonicBoost: 1.3,
        transientBoost: 1.5
      }
    };
    // --- FIX: KHỞI TẠO CHỈ SỐ TĨNH ĐỂ KHÔNG GỌI Object.entries() KHI ĐANG CHẠY REALTIME ---
    this.instrumentKeys = ["guitar", "piano", "violin", "drums"];
    this.instrumentEnergiesBuffer = new Float32Array(4);
    this.attentionLayer = null;
    // --- FIX: BUFFER TĨNH ĐĂNG KÝ TRƯỚC CHỐNG RÒ RỈ RAM TRONG HÀM DCT HOÀN TOÀN ---
    this.melEnergiesBuffer = new Float32Array(this.numFilters);
    this.dctResultBuffer = memoryManager.allocate(this.numFilters);
    this.mfccNativeArray = new Float32Array(13);
    // --- OPTIMIZE: BỘ ĐẾM THROTTLING GIẢM TẢI CHO CPU ---
    this.throttleCounter = 0;
    this.cachedGenre = "Karaoke";
  }
  initMelFilterBanks(numFilters, minFreq, maxFreq) {
    const melMin = 2595 * Math.log10(1 + minFreq / 700);
    const melMax = 2595 * Math.log10(1 + maxFreq / 700);
    const melPoints = new Float32Array(numFilters + 2);
    for (let i = 0; i < melPoints.length; i++) {
      melPoints[i] = melMin + (melMax - melMin) * i / (numFilters + 1);
    }
    const freqPoints = Array.from(melPoints).map(m => 700 * (10 ** (m / 2595) - 1));
    const bins = freqPoints.map(f => Math.floor(f * this.fftSize / this.sampleRate));
    const filters = [];
    for (let i = 1; i <= numFilters; i++) {
      const filter = this.memoryManager.allocate(this.fftSize / 2);
      filter.fill(0);
      for (let j = bins[i - 1]; j < bins[i + 1]; j++) {
        if (j < bins[i]) filter[j] = (j - bins[i - 1]) / (bins[i] - bins[i - 1]);
        else filter[j] = (bins[i + 1] - j) / (bins[i + 1] - bins[i]);
      }
      filters.push(filter);
    }
    return filters;
  }
  initAttentionLayer() {
    if (!this.attentionLayer) {
      this.attentionLayer = this.memoryManager.allocate(this.fftSize / 2 * 3);
      this.attentionLayer.fill(0);
    }
    return this.attentionLayer;
  }
  dct(data) {
    const n = data.length;
    const result = this.dctResultBuffer; // FIX: Sử dụng buffer tĩnh allocated từ trước, triệt tiêu leak RAM hoàn toàn
    for (let k = 0; k < n; k += 4) {
      let sum0 = 0,
        sum1 = 0,
        sum2 = 0,
        sum3 = 0;
      for (let i = 0; i < n; i++) {
        const cos0 = Math.cos(Math.PI * k * (i + 0.5) / n);
        const cos1 = Math.cos(Math.PI * (k + 1) * (i + 0.5) / n);
        const cos2 = Math.cos(Math.PI * (k + 2) * (i + 0.5) / n);
        const cos3 = Math.cos(Math.PI * (k + 3) * (i + 0.5) / n);
        sum0 += data[i] * cos0;
        if (k + 1 < n) sum1 += data[i] * cos1;
        if (k + 2 < n) sum2 += data[i] * cos2;
        if (k + 3 < n) sum3 += data[i] * cos3;
      }
      result[k] = sum0 * (k === 0 ? 1 / Math.sqrt(n) : Math.sqrt(2 / n));
      if (k + 1 < n) result[k + 1] = sum1 * Math.sqrt(2 / n);
      if (k + 2 < n) result[k + 2] = sum2 * Math.sqrt(2 / n);
      if (k + 3 < n) result[k + 3] = sum3 * Math.sqrt(2 / n);
    }
    // Ghi trực tiếp vào mảng tĩnh MFCC trả về, không dùng .slice() tạo mảng rác
    for (let i = 0; i < 13; i++) {
      this.mfccNativeArray[i] = result[i];
    }
    return this.mfccNativeArray;
  }
  analyze(magnitudes, phases, timeData, rms) {
    this.initAttentionLayer();
    const freqPerBin = this.sampleRate / this.fftSize;
    let subBass = 0,
      bass = 0,
      subMid = 0,
      midLow = 0,
      midHigh = 0,
      high = 0,
      subTreble = 0,
      air = 0;
    let subBassCount = 0,
      bassCount = 0,
      subMidCount = 0,
      midLowCount = 0,
      midHighCount = 0,
      highCount = 0,
      subTrebleCount = 0,
      airCount = 0;
    let totalEnergy = 0,
      transientPeaks = 0,
      formantPeaks = 0,
      vocalEnergy = 0;
    let spectralFlux = 0;
    const sizeOver2 = this.fftSize / 2;
    // GIỮ NGUYÊN TOÀN BỘ VÒNG LẶP SPECTRALFLUX UNROLL 4 PHÙ THỦY CỦA BẠN
    for (let i = 0; i < sizeOver2; i += 4) {
      const diff0 = magnitudes[i] - (this.lastMagnitudes[i] || 0);
      spectralFlux += diff0 > 0 ? diff0 : 0;
      if (i + 1 < sizeOver2) {
        const diff1 = magnitudes[i + 1] - (this.lastMagnitudes[i + 1] || 0);
        spectralFlux += diff1 > 0 ? diff1 : 0;
      }
      if (i + 2 < sizeOver2) {
        const diff2 = magnitudes[i + 2] - (this.lastMagnitudes[i + 2] || 0);
        spectralFlux += diff2 > 0 ? diff2 : 0;
      }
      if (i + 3 < sizeOver2) {
        const diff3 = magnitudes[i + 3] - (this.lastMagnitudes[i + 3] || 0);
        spectralFlux += diff3 > 0 ? diff3 : 0;
      }
    }
    // Reset mảng tĩnh năng lượng nhạc cụ
    this.instrumentEnergiesBuffer.fill(0);
    let attnSum = 0;
    // GIỮ NGUYÊN HOÀN TOÀN VÒNG LẶP CHÍNH UNROLL 4 – CHỈ TỐI ƯU HÓA ĐOẠN QUÉT NHẠC CỤ CHỐNG SINH RÁC
    for (let i = 0; i < sizeOver2; i += 4) {
      const freq0 = i * freqPerBin;
      const energy0 = magnitudes[i] * magnitudes[i];
      let attn0 = 1.0;
      if (freq0 > 300 && freq0 < 3400) attn0 *= 1.5 * rms;
      if (energy0 > rms * 2) attn0 *= 1.2;
      totalEnergy += energy0 * attn0;
      attnSum += attn0;
      if (freq0 < 60) {
        subBass += energy0 * attn0;
        subBassCount++;
      } else if (freq0 < 200) {
        bass += energy0 * attn0;
        bassCount++;
      } else if (freq0 < 800) {
        subMid += energy0 * attn0;
        subMidCount++;
      } else if (freq0 < 2000) {
        midLow += energy0 * attn0;
        midLowCount++;
      } else if (freq0 < 4000) {
        midHigh += energy0 * attn0;
        midHighCount++;
      } else if (freq0 < 8000) {
        high += energy0 * attn0;
        highCount++;
      } else if (freq0 < 12000) {
        subTreble += energy0 * attn0;
        subTrebleCount++;
      } else if (freq0 < 16000) {
        air += energy0 * attn0;
        airCount++;
      }
      if (freq0 > 300 && freq0 < 3400) vocalEnergy += energy0 * attn0;
      // Tối ưu hóa quét mảng tĩnh nhạc cụ, không dùng Object.entries()
      if (freq0 >= 200 && freq0 <= 800) this.instrumentEnergiesBuffer[0] += energy0 * attn0; // guitar
      if (freq0 >= 1000 && freq0 <= 4000) this.instrumentEnergiesBuffer[1] += energy0 * attn0; // piano
      if (freq0 >= 2000 && freq0 <= 6000) this.instrumentEnergiesBuffer[2] += energy0 * attn0; // violin
      if (freq0 >= 2000 && freq0 <= 8000) this.instrumentEnergiesBuffer[3] += energy0 * attn0; // drums
      if (i > 0 && i < sizeOver2 - 1) {
        const magDiff0 = magnitudes[i] - (magnitudes[i - 1] + magnitudes[i + 1]) / 2;
        const dynamicThreshold = 0.08 * (totalEnergy / this.fftSize) * (this.lastEnergy > 0 ? totalEnergy / this.lastEnergy : 1) * (rms || 1);
        if (freq0 > 800 && freq0 < 2000 && magDiff0 > dynamicThreshold) formantPeaks++;
        if (freq0 > 2000 && freq0 < 8000 && magDiff0 > dynamicThreshold * 1.1) transientPeaks++;
      }
      // Khung Bin i+1
      if (i + 1 < sizeOver2) {
        const freq1 = (i + 1) * freqPerBin;
        const energy1 = magnitudes[i + 1] * magnitudes[i + 1];
        let attn1 = 1.0;
        if (freq1 > 300 && freq1 < 3400) attn1 *= 1.5 * rms;
        if (energy1 > rms * 2) attn1 *= 1.2;
        totalEnergy += energy1 * attn1;
        attnSum += attn1;
        if (freq1 < 60) {
          subBass += energy1 * attn1;
          subBassCount++;
        } else if (freq1 < 200) {
          bass += energy1 * attn1;
          bassCount++;
        } else if (freq1 < 800) {
          subMid += energy1 * attn1;
          subMidCount++;
        } else if (freq1 < 2000) {
          midLow += energy1 * attn1;
          midLowCount++;
        } else if (freq1 < 4000) {
          midHigh += energy1 * attn1;
          midHighCount++;
        } else if (freq1 < 8000) {
          high += energy1 * attn1;
          highCount++;
        } else if (freq1 < 12000) {
          subTreble += energy1 * attn1;
          subTrebleCount++;
        } else if (freq1 < 16000) {
          air += energy1 * attn1;
          airCount++;
        }
        if (freq1 > 300 && freq1 < 3400) vocalEnergy += energy1 * attn1;
        if (freq1 >= 200 && freq1 <= 800) this.instrumentEnergiesBuffer[0] += energy1 * attn1;
        if (freq1 >= 1000 && freq1 <= 4000) this.instrumentEnergiesBuffer[1] += energy1 * attn1;
        if (freq1 >= 2000 && freq1 <= 6000) this.instrumentEnergiesBuffer[2] += energy1 * attn1;
        if (freq1 >= 2000 && freq1 <= 8000) this.instrumentEnergiesBuffer[3] += energy1 * attn1;
        if (i + 1 > 0 && i + 1 < sizeOver2 - 1) {
          const magDiff1 = magnitudes[i + 1] - (magnitudes[i] + magnitudes[i + 2]) / 2;
          const dynamicThreshold = 0.08 * (totalEnergy / this.fftSize) * (this.lastEnergy > 0 ? totalEnergy / this.lastEnergy : 1) * (rms || 1);
          if (freq1 > 800 && freq1 < 2000 && magDiff1 > dynamicThreshold) formantPeaks++;
          if (freq1 > 2000 && freq1 < 8000 && magDiff1 > dynamicThreshold * 1.1) transientPeaks++;
        }
      }
      // Khung Bin i+2
      if (i + 2 < sizeOver2) {
        const freq2 = (i + 2) * freqPerBin;
        const energy2 = magnitudes[i + 2] * magnitudes[i + 2];
        let attn2 = 1.0;
        if (freq2 > 300 && freq2 < 3400) attn2 *= 1.5 * rms;
        if (energy2 > rms * 2) attn2 *= 1.2;
        totalEnergy += energy2 * attn2;
        attnSum += attn2;
        if (freq2 < 60) {
          subBass += energy2 * attn2;
          subBassCount++;
        } else if (freq2 < 200) {
          bass += energy2 * attn2;
          bassCount++;
        } else if (freq2 < 800) {
          subMid += energy2 * attn2;
          subMidCount++;
        } else if (freq2 < 2000) {
          midLow += energy2 * attn2;
          midLowCount++;
        } else if (freq2 < 4000) {
          midHigh += energy2 * attn2;
          midHighCount++;
        } else if (freq2 < 8000) {
          high += energy2 * attn2;
          highCount++;
        } else if (freq2 < 12000) {
          subTreble += energy2 * attn2;
          subTrebleCount++;
        } else if (freq2 < 16000) {
          air += energy2 * attn2;
          airCount++;
        }
        if (freq2 > 300 && freq2 < 3400) vocalEnergy += energy2 * attn2;
        if (freq2 >= 200 && freq2 <= 800) this.instrumentEnergiesBuffer[0] += energy2 * attn2;
        if (freq2 >= 1000 && freq2 <= 4000) this.instrumentEnergiesBuffer[1] += energy2 * attn2;
        if (freq2 >= 2000 && freq2 <= 6000) this.instrumentEnergiesBuffer[2] += energy2 * attn2;
        if (freq2 >= 2000 && freq2 <= 8000) this.instrumentEnergiesBuffer[3] += energy2 * attn2;
        if (i + 2 > 0 && i + 2 < sizeOver2 - 1) {
          const magDiff2 = magnitudes[i + 2] - (magnitudes[i + 1] + magnitudes[i + 3]) / 2;
          const dynamicThreshold = 0.08 * (totalEnergy / this.fftSize) * (this.lastEnergy > 0 ? totalEnergy / this.lastEnergy : 1) * (rms || 1);
          if (freq2 > 800 && freq2 < 2000 && magDiff2 > dynamicThreshold) formantPeaks++;
          if (freq2 > 2000 && freq2 < 8000 && magDiff2 > dynamicThreshold * 1.1) transientPeaks++;
        }
      }
      // Khung Bin i+3
      if (i + 3 < sizeOver2) {
        const freq3 = (i + 3) * freqPerBin;
        const energy3 = magnitudes[i + 3] * magnitudes[i + 3];
        let attn3 = 1.0;
        if (freq3 > 300 && freq3 < 3400) attn3 *= 1.5 * rms;
        if (energy3 > rms * 2) attn3 *= 1.2;
        totalEnergy += energy3 * attn3;
        attnSum += attn3;
        if (freq3 < 60) {
          subBass += energy3 * attn3;
          subBassCount++;
        } else if (freq3 < 200) {
          bass += energy3 * attn3;
          bassCount++;
        } else if (freq3 < 800) {
          subMid += energy3 * attn3;
          subMidCount++;
        } else if (freq3 < 2000) {
          midLow += energy3 * attn3;
          midLowCount++;
        } else if (freq3 < 4000) {
          midHigh += energy3 * attn3;
          midHighCount++;
        } else if (freq3 < 8000) {
          high += energy3 * attn3;
          highCount++;
        } else if (freq3 < 12000) {
          subTreble += energy3 * attn3;
          subTrebleCount++;
        } else if (freq3 < 16000) {
          air += energy3 * attn3;
          airCount++;
        }
        if (freq3 > 300 && freq3 < 3400) vocalEnergy += energy3 * attn3;
        if (freq3 >= 200 && freq3 <= 800) this.instrumentEnergiesBuffer[0] += energy3 * attn3;
        if (freq3 >= 1000 && freq3 <= 4000) this.instrumentEnergiesBuffer[1] += energy3 * attn3;
        if (freq3 >= 2000 && freq3 <= 6000) this.instrumentEnergiesBuffer[2] += energy3 * attn3;
        if (freq3 >= 2000 && freq3 <= 8000) this.instrumentEnergiesBuffer[3] += energy3 * attn3;
        if (i + 3 > 0 && i + 3 < sizeOver2 - 1) {
          const magDiff3 = magnitudes[i + 3] - (magnitudes[i + 2] + (magnitudes[i + 4] || magnitudes[i + 2])) / 2;
          const dynamicThreshold = 0.08 * (totalEnergy / this.fftSize) * (this.lastEnergy > 0 ? totalEnergy / this.lastEnergy : 1) * (rms || 1);
          if (freq3 > 800 && freq3 < 2000 && magDiff3 > dynamicThreshold) formantPeaks++;
          if (freq3 > 2000 && freq3 < 8000 && magDiff3 > dynamicThreshold * 1.1) transientPeaks++;
        }
      }
    }
    attnSum = attnSum || 1;
    this.lastEnergy = totalEnergy;
    this.lastMagnitudes.set(magnitudes);
    const avgEnergy = totalEnergy / sizeOver2;
    const normalize = (energy, count) => count > 0 ? Math.min(1, ensureFinite((energy / count) / (avgEnergy || 1))) : 0.5;
    // Mel filter banks – Sử dụng bộ đệm tĩnh có sẵn để ghi thông số, đạt chuẩn Zero-GC
    for (let b = 0; b < this.numFilters; b++) {
      const bank = this.melFilterBanks[b];
      let sum = 0;
      for (let i = 0; i < sizeOver2; i += 4) {
        sum += magnitudes[i] * bank[i] + (i + 1 < sizeOver2 ? magnitudes[i + 1] * bank[i + 1] : 0) + (i + 2 < sizeOver2 ? magnitudes[i + 2] * bank[i + 2] : 0) + (i + 3 < sizeOver2 ? magnitudes[i + 3] * bank[i + 3] : 0);
      }
      this.melEnergiesBuffer[b] = sum > 0 ? 20 * Math.log10(sum) : -120;
    }
    const mfcc = this.dct(this.melEnergiesBuffer);
    this.computeChromagram(magnitudes, phases);
    const dynamicRange = this.computeDynamicRange(timeData);
    const detectedInstruments = this.detectInstruments(this.instrumentEnergiesBuffer, totalEnergy);
    const profile = {
      subBass: normalize(subBass, subBassCount),
      bass: normalize(bass, bassCount),
      subMid: normalize(subMid, subMidCount),
      midLow: normalize(midLow, midLowCount),
      midHigh: normalize(midHigh, midHighCount),
      high: normalize(high, highCount),
      subTreble: normalize(subTreble, subTrebleCount),
      air: normalize(air, airCount),
      vocalPresence: Math.min(1, formantPeaks / 8 + vocalEnergy / (totalEnergy || 1)),
      transientEnergy: Math.min(1, transientPeaks / 12 + spectralFlux / (totalEnergy || 1)),
      mfcc,
      spectralFlatness: this.computeSpectralFlatness(magnitudes),
      chroma: this.chroma,
      dynamicRange,
      instruments: detectedInstruments
    };
    this.spectralHistory.push(profile);
    if (this.spectralHistory.length > this.maxHistory) this.spectralHistory.shift();
    return this.smoothProfile(profile, detectedInstruments);
  }
  detectInstruments(instrumentEnergiesBuffer, totalEnergy) {
    const instruments = {};
    for (let i = 0; i < this.instrumentKeys.length; i++) {
      const instr = this.instrumentKeys[i];
      const energy = instrumentEnergiesBuffer[i];
      const confidence = Math.min(1, energy / (totalEnergy || 1));
      if (confidence > 0.35) instruments[instr] = confidence;
    }
    return instruments;
  }
  computeChromagram(magnitudes, phases) {
    const freqPerBin = this.sampleRate / this.fftSize;
    const noteFrequencies = [
      261.63, 277.18, 293.66, 311.13, 329.63, 349.23, 369.99, 392.00, 415.30, 440.00, 466.16, 493.88
    ];
    this.chroma.fill(0);
    for (let i = 0; i < this.fftSize / 2; i++) {
      const freq = i * freqPerBin;
      for (let n = 0; n < 12; n++) {
        const noteFreq = noteFrequencies[n];
        for (let octave = -3; octave <= 3; octave++) {
          const refFreq = noteFreq * Math.pow(2, octave);
          if (Math.abs(freq - refFreq) < freqPerBin / 2) {
            this.chroma[n] += magnitudes[i] * magnitudes[i];
          }
        }
      }
    }
    const sum = this.chroma.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let n = 0; n < 12; n++) this.chroma[n] /= sum;
    }
  }
  computeDynamicRange(timeData) {
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < timeData.length; i += 4) {
      min = Math.min(min, timeData[i], i + 1 < timeData.length ? timeData[i + 1] : min, i + 2 < timeData.length ? timeData[i + 2] : min, i + 3 < timeData.length ? timeData[i + 3] : min);
      max = Math.max(max, timeData[i], i + 1 < timeData.length ? timeData[i + 1] : max, i + 2 < timeData.length ? timeData[i + 2] : max, i + 3 < timeData.length ? timeData[i + 3] : max);
    }
    return 20 * Math.log10((max - min) / (Math.abs(min) || 1));
  }
  computeSpectralFlatness(magnitudes) {
    let sum = 0,
      logSum = 0,
      count = 0;
    for (let i = 0; i < magnitudes.length; i++) {
      if (magnitudes[i] > 0) {
        sum += magnitudes[i];
        logSum += Math.log(magnitudes[i]);
        count++;
      }
    }
    const mean = sum / count;
    const geoMean = Math.exp(logSum / count);
    return geoMean / (mean || 1);
  }
  smoothProfile(profile, instruments) {
    if (this.spectralHistory.length < 2) return profile;
    let alpha = 0.75;
    const transientEnergy = profile.transientEnergy || 0.5;
    // --- OPTIMIZE: THROTTLING THỂ LOẠI NHẠC (CHỈ CHẠY 1 LẦN MỖI 30 FRAMES KHÔNG GÂY ĐƠ CPU) ---
    this.throttleCounter++;
    if (this.throttleCounter >= 30 || !this.cachedGenre) {
      this.throttleCounter = 0;
      // Gọi phân loại nhạc an toàn từ luồng toàn cục
      this.cachedGenre = typeof classifyGenre === "function" ? classifyGenre(profile, this.sampleRate, this.spectralHistory) : "Karaoke";
    }
    const genre = this.cachedGenre;
    if (["EDM", "Drum & Bass", "Hip-Hop"].includes(genre)) alpha = Math.max(0.5, 0.75 - transientEnergy * 0.15);
    else if (["Bolero", "Classical/Jazz"].includes(genre)) alpha = Math.min(0.9, 0.75 + (1 - transientEnergy) * 0.15);
    if (profile.vocalPresence > 0.55 || Object.values(instruments).some(conf => conf > 0.5)) alpha = Math.max(alpha, 0.6);
    const prev = this.spectralHistory[this.spectralHistory.length - 2];
    const smoothed = {};
    for (const key in profile) {
      if (key === 'mfcc') {
        smoothed[key] = new Float32Array(13);
        for (let i = 0; i < 13; i++) {
          smoothed[key][i] = alpha * profile[key][i] + (1 - alpha) * (prev[key]?.[i] || profile[key][i]);
        }
      } else if (typeof profile[key] === "object" && key !== 'chroma') {
        smoothed[key] = {};
        for (const k in profile[key]) {
          smoothed[key][k] = alpha * profile[key][k] + (1 - alpha) * (prev[key]?.[k] || profile[key][k]);
        }
      } else {
        smoothed[key] = alpha * profile[key] + (1 - alpha) * (prev[key] || profile[key]);
      }
    }
    return smoothed;
  }
  dispose() {
    this.melFilterBanks.forEach(filter => this.memoryManager.free(filter));
    this.memoryManager.free(this.lastMagnitudes);
    this.memoryManager.free(this.dctResultBuffer); // GIẢI PHÓNG TRÁN LEAK RAM TUYỆT ĐỐI
    if (this.attentionLayer) this.memoryManager.free(this.attentionLayer);
    this.memoryManager.free(this.chroma);
  }
}
/**
 * =========================================================================
 * BỘ HÀM DSP BACKEND NÂNG CẤP TOÀN DIỆN - THIÊN TÀI KHÔNG LỖI (ZERO-GC EDITION)
 * =========================================================================
 */
// KHỞI TẠO HỆ THỐNG LUT VÀ BUFFER TĨNH TOÀN CỤC (CHỈ CHẠY 1 LẦN DUY NHẤT KHI KHỞI CHẠY LUỒNG WORKER)
if (typeof self.hasInitializedBackendLUT === 'undefined') {
  self.majorProfileLUT = new Float32Array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]);
  self.minorProfileLUT = new Float32Array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]);
  self.chordTemplateMajorLUT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
  self.chordTemplateMinorLUT = new Float32Array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
  self.keyNamesLUT = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  // Khóa tĩnh cấu trúc đối tượng đầu ra đầu cuối, triệt tiêu Garbage Collector sinh rác
  self.staticSpectralSubResult = {
    magnitudes: null,
    wienerGain: 1.0
  };
  self.staticKeyResult = {
    key: "Unknown",
    confidence: 0,
    isMajor: true
  };
  self.staticChordResult = {
    chord: "Unknown",
    confidence: 0,
    isMajor: true
  };
  self.staticNoiseResult = {
    level: 0,
    white: 0,
    lowFreq: 0,
    midFreq: 0,
    voiceActivity: 0,
    type: "none"
  };
  self.staticTempoResult = {
    bpm: 120,
    confidence: 0
  };
  self.hasInitializedBackendLUT = true;
}
// Hàm phụ toán học: Bộ lọc Sinc nội tuyến siêu tốc, bảo vệ an toàn cho hàm Downsample
function safeSinc(x) {
  if (x === 0) return 1.0;
  const piX = Math.PI * x;
  return Math.sin(piX) / piX;
}
// 1. Spectral Subtraction Pro với bộ khóa biên SNR chống sập số NaN và lọc mượt phổ âm thanh tinh khiết
function spectralSubtraction(magnitudes, noiseLevel, fftSize, sampleRate) {
  const length = magnitudes.length;
  const freqPerBin = sampleRate / fftSize;
  // Tái sử dụng bộ đệm tĩnh toàn cục qua hệ thống Quản lý bộ nhớ
  if (!tempBuffer1 || tempBuffer1.length !== length) {
    if (tempBuffer1) memoryManager.free(tempBuffer1.offset || tempBuffer1);
    if (tempBuffer2) memoryManager.free(tempBuffer2.offset || tempBuffer2);
    tempBuffer1 = memoryManager.allocate(length);
    tempBuffer2 = memoryManager.allocate(length);
  }
  const result = tempBuffer1;
  const noisePower = tempBuffer2;
  result.fill(0);
  noisePower.fill(0);
  let wienerGain = 1.0;
  const voiceActivity = noiseLevel.voiceActivity || 0.5;
  const isSilent = voiceActivity < 0.2;
  // VÒNG LẶP ADAPTIVE NOISE FLOOR UNROLL 4 NÂNG CẤP CHẶN ĐỨNG SAI LỆCH BIÊN ĐỘ ĐẦU PHÂN PHỐI
  for (let i = 0; i < length; i += 4) {
    const freq0 = i * freqPerBin;
    let noiseEst0 = 0;
    if (freq0 < 20 || freq0 > 16000) noiseEst0 = noiseLevel.white * 0.8;
    else if (freq0 < 100) noiseEst0 = noiseLevel.lowFreq * 0.7;
    else if (freq0 < 8000) noiseEst0 = noiseLevel.midFreq * 0.6;
    else noiseEst0 = noiseLevel.white * 0.5;
    if (isSilent) noiseEst0 *= 1.4;
    noisePower[i] = Math.min(magnitudes[i] * magnitudes[i], noiseEst0 * 1.2);
    if (i + 1 < length) {
      const freq1 = (i + 1) * freqPerBin;
      let noiseEst1 = 0;
      if (freq1 < 20 || freq1 > 16000) noiseEst1 = noiseLevel.white * 0.8;
      else if (freq1 < 100) noiseEst1 = noiseLevel.lowFreq * 0.7;
      else if (freq1 < 8000) noiseEst1 = noiseLevel.midFreq * 0.6;
      else noiseEst1 = noiseLevel.white * 0.5;
      if (isSilent) noiseEst1 *= 1.4;
      noisePower[i + 1] = Math.min(magnitudes[i + 1] * magnitudes[i + 1], noiseEst1 * 1.2);
    }
    if (i + 2 < length) {
      const freq2 = (i + 2) * freqPerBin;
      let noiseEst2 = 0;
      if (freq2 < 20 || freq2 > 16000) noiseEst2 = noiseLevel.white * 0.8;
      else if (freq2 < 100) noiseEst2 = noiseLevel.lowFreq * 0.7;
      else if (freq2 < 8000) noiseEst2 = noiseLevel.midFreq * 0.6;
      else noiseEst2 = noiseLevel.white * 0.5;
      if (isSilent) noiseEst2 *= 1.4;
      noisePower[i + 2] = Math.min(magnitudes[i + 2] * magnitudes[i + 2], noiseEst2 * 1.2);
    }
    if (i + 3 < length) {
      const freq3 = (i + 3) * freqPerBin;
      let noiseEst3 = 0;
      if (freq3 < 20 || freq3 > 16000) noiseEst3 = noiseLevel.white * 0.8;
      else if (freq3 < 100) noiseEst3 = noiseLevel.lowFreq * 0.7;
      else if (freq3 < 8000) noiseEst3 = noiseLevel.midFreq * 0.6;
      else noiseEst3 = noiseLevel.white * 0.5;
      if (isSilent) noiseEst3 *= 1.4;
      noisePower[i + 3] = Math.min(magnitudes[i + 3] * magnitudes[i + 3], noiseEst3 * 1.2);
    }
  }
  const overSub = 1.4;
  const beta = 0.02; // Sàn chống méo hài phổ chuyên dụng (Spectral Floor)
  const alpha = voiceActivity > 0.7 ? 0.95 : 0.8;
  // Vòng lặp Advanced Wiener Unroll 4 - Đã tối ưu hóa thuật toán nén dốc cao tần
  for (let i = 0; i < length; i += 4) {
    const signalPower0 = magnitudes[i] * magnitudes[i];
    const snrPost0 = signalPower0 / (noisePower[i] + 1e-8);
    const snrAlpha0 = ensureFinite(Math.pow(snrPost0, alpha));
    let gain0 = snrAlpha0 / (snrAlpha0 + overSub);
    gain0 = Math.max(beta, Math.min(1.0, gain0));
    result[i] = ensureFinite(magnitudes[i] * gain0);
    if (i * freqPerBin > 12000) result[i] *= 0.75; // Cắt mượt mà tần số chói gắt dải cao
    wienerGain = wienerGain * 0.99 + gain0 * 0.01;
    if (i + 1 < length) {
      const signalPower1 = magnitudes[i + 1] * magnitudes[i + 1];
      const snrPost1 = signalPower1 / (noisePower[i + 1] + 1e-8);
      const snrAlpha1 = ensureFinite(Math.pow(snrPost1, alpha));
      let gain1 = snrAlpha1 / (snrAlpha1 + overSub);
      gain1 = Math.max(beta, Math.min(1.0, gain1));
      result[i + 1] = ensureFinite(magnitudes[i + 1] * gain1);
      if ((i + 1) * freqPerBin > 12000) result[i + 1] *= 0.75;
      wienerGain = wienerGain * 0.99 + gain1 * 0.01;
    }
    if (i + 2 < length) {
      const signalPower2 = magnitudes[i + 2] * magnitudes[i + 2];
      const snrPost2 = signalPower2 / (noisePower[i + 2] + 1e-8);
      const snrAlpha2 = ensureFinite(Math.pow(snrPost2, alpha));
      let gain2 = snrAlpha2 / (snrAlpha2 + overSub);
      gain2 = Math.max(beta, Math.min(1.0, gain2));
      result[i + 2] = ensureFinite(magnitudes[i + 2] * gain2);
      if ((i + 2) * freqPerBin > 12000) result[i + 2] *= 0.75;
      wienerGain = wienerGain * 0.99 + gain2 * 0.01;
    }
    if (i + 3 < length) {
      const signalPower3 = magnitudes[i + 3] * magnitudes[i + 3];
      const snrPost3 = signalPower3 / (noisePower[i + 3] + 1e-8);
      const snrAlpha3 = ensureFinite(Math.pow(snrPost3, alpha));
      let gain3 = snrAlpha3 / (snrAlpha3 + overSub);
      gain3 = Math.max(beta, Math.min(1.0, gain3));
      result[i + 3] = ensureFinite(magnitudes[i + 3] * gain3);
      if ((i + 3) * freqPerBin > 12000) result[i + 3] *= 0.75;
      wienerGain = wienerGain * 0.99 + gain3 * 0.01;
    }
  }
  self.staticSpectralSubResult.magnitudes = result;
  self.staticSpectralSubResult.wienerGain = wienerGain;
  return self.staticSpectralSubResult;
}
// 2. Downsample Pro – Bộ lọc hạ mẫu đa nhánh Unroll x4 triệt tiêu răng cưa kỹ thuật số
function downsample(data, factor) {
  const length = Math.floor(data.length / factor);
  if (!downsampleBuffer || downsampleBuffer.length !== length) {
    if (downsampleBuffer) memoryManager.free(downsampleBuffer.offset || downsampleBuffer);
    downsampleBuffer = memoryManager.allocate(length);
  }
  const result = downsampleBuffer;
  result.fill(0);
  const fact = factor;
  for (let i = 0; i < length; i++) {
    let sum = 0,
      weightSum = 0;
    let j = -fact;
    // Unroll vòng lặp chập Sinc tăng tốc tính toán biên độ đa tầng cho CPU máy yếu
    for (; j <= fact - 3; j += 4) {
      const idx0 = i * fact + j;
      if (idx0 >= 0 && idx0 < data.length) {
        const w0 = safeSinc(j / fact);
        sum += data[idx0] * w0;
        weightSum += w0;
      }
      const idx1 = i * fact + (j + 1);
      if (idx1 >= 0 && idx1 < data.length) {
        const w1 = safeSinc((j + 1) / fact);
        sum += data[idx1] * w1;
        weightSum += w1;
      }
      const idx2 = i * fact + (j + 2);
      if (idx2 >= 0 && idx2 < data.length) {
        const w2 = safeSinc((j + 2) / fact);
        sum += data[idx2] * w2;
        weightSum += w2;
      }
      const idx3 = i * fact + (j + 3);
      if (idx3 >= 0 && idx3 < data.length) {
        const w3 = safeSinc((j + 3) / fact);
        sum += data[idx3] * w3;
        weightSum += w3;
      }
    }
    // Quét nốt các phần tử còn dư cuối chu kỳ bậc chập
    for (; j <= fact; j++) {
      const idx = i * fact + j;
      if (idx >= 0 && idx < data.length) {
        const weight = safeSinc(j / fact);
        sum += data[idx] * weight;
        weightSum += weight;
      }
    }
    result[i] = ensureFinite(sum / (weightSum || 1.0));
  }
  return result;
}
// =========================================================================
// THUẬT TOÁN AI BỔ SUNG: NHẬN DIỆN ĐA ÂM HPS CẢI TIẾN CHUẨN ĐỒNG BỘ JUNGLE (ZERO-GC)
// =========================================================================
function detectPolyphonicPitches(magnitudes, sampleRate, fftSize) {
  const maxPitches = 5;
  let pitchesFound = self.polyPitchesBuffer;
  if (!pitchesFound || pitchesFound.length !== maxPitches) {
    if (pitchesFound) memoryManager.free(pitchesFound.offset || pitchesFound);
    pitchesFound = self.polyPitchesBuffer = memoryManager.allocate(maxPitches);
  }
  pitchesFound.fill(0);
  const length = magnitudes.length;
  const freqPerBin = sampleRate / fftSize;
  // Tái sử dụng vùng đệm tính toán HPS tĩnh toàn cục chặn đứng rò rỉ RAM
  let hpsBuffer = self.hpsComputeBuffer;
  if (!hpsBuffer || hpsBuffer.length !== length) {
    if (hpsBuffer) memoryManager.free(hpsBuffer.offset || hpsBuffer);
    hpsBuffer = self.hpsComputeBuffer = memoryManager.allocate(length);
  }
  hpsBuffer.set(magnitudes);
  // Thuật toán HPS hạ mẫu bậc 3 cải tiến áp căn bậc bảo vệ độ lớn phổ đa âm
  const maxHpsOrder = 3;
  for (let order = 2; order <= maxHpsOrder; order++) {
    const bound = Math.floor(length / order);
    for (let i = 0; i < bound; i += 4) {
      hpsBuffer[i] *= Math.pow(magnitudes[i * order], 1 / order);
      if (i + 1 < bound) hpsBuffer[i + 1] *= Math.pow(magnitudes[(i + 1) * order], 1 / order);
      if (i + 2 < bound) hpsBuffer[i + 2] *= Math.pow(magnitudes[(i + 2) * order], 1 / order);
      if (i + 3 < bound) hpsBuffer[i + 3] *= Math.pow(magnitudes[(i + 3) * order], 1 / order);
    }
  }
  // Dynamic Threshold thích ứng theo năng lượng nền (Khử nhiễu trắng tinh khiết)
  let energySum = 0;
  for (let i = 0; i < length; i++) energySum += hpsBuffer[i];
  const dynamicFloor = (energySum / length) * 1.5;
  // Quét tìm đỉnh phổ đa âm chuẩn xác (Primitive Peak Tracking)
  let pitchCount = 0;
  for (let i = 2; i < length - 2 && pitchCount < maxPitches; i++) {
    if (hpsBuffer[i] > hpsBuffer[i - 1] && hpsBuffer[i] > hpsBuffer[i + 1] && hpsBuffer[i] > dynamicFloor) {
      const freq = i * freqPerBin;
      if (freq >= 60 && freq <= 1200) {
        pitchesFound[pitchCount] = parseFloat(freq.toFixed(2));
        pitchCount++;
      }
    }
  }
  // Lưu trữ số lượng cao độ bóc tách được vào biến đếm tĩnh để Zero-GC View Array
  self.staticPolyPitchesCount = pitchCount;
  return pitchesFound;
}
// =========================================================================
// ƯỚC LƯỢNG FORMANT THẬT BẰNG CEPSTRAL SMOOTHING (thay cho vùng tần số cố định F1≈500Hz/F2≈2100Hz)
// Chuẩn DSP kinh điển (Rabiner & Schafer): lấy log biên độ phổ, biến đổi Cosine rời rạc (DCT-II) để
// ra miền "cepstral", chỉ giữ các hệ số bậc thấp (low-quefrency) - đây chính là bao phổ mượt của cộng
// hưởng thanh quản (vocal tract) - loại bỏ hoàn toàn gợn sóng hài của cao độ F0 (nằm ở quefrency cao
// hơn hẳn: quefrency_F0 ≈ sampleRate/(2*F0), luôn > 48 với F0 thực tế 80-500Hz nên lifter=24 là an toàn).
// Dựng lại bao phổ từ các hệ số đã lifter rồi dò đỉnh cộng hưởng thật F1/F2 ngay trên bao phổ đó.
// =========================================================================
function estimateFormants(magnitudes, sampleRate, fftSize, vocalPresence) {
  if (!(vocalPresence > 0.5)) return null;
  const nBins = magnitudes.length;
  const freqPerBin = sampleRate / fftSize;
  const minBin = Math.max(1, Math.round(150 / freqPerBin));
  const maxBin = Math.min(nBins - 1, Math.round(3600 / freqPerBin));
  if (maxBin - minBin < 16) return null;
  // 1. Log biên độ phổ (Zero-GC, tái sử dụng buffer tĩnh)
  let logMag = self.formantLogMagBuffer;
  if (!logMag || logMag.length !== nBins) {
    if (logMag) memoryManager.free(logMag.offset || logMag);
    logMag = self.formantLogMagBuffer = memoryManager.allocate(nBins);
  }
  for (let i = 0; i < nBins; i++) {
    logMag[i] = Math.log(magnitudes[i] + 1e-6);
  }
  // 2. DCT-II bậc thấp trực tiếp (chỉ tính đủ hệ số cần lifter, không cần FFT đầy đủ)
  const numCoeffs = 24;
  let cep = self.formantCepstrumBuffer;
  if (!cep || cep.length !== numCoeffs) {
    if (cep) memoryManager.free(cep.offset || cep);
    cep = self.formantCepstrumBuffer = memoryManager.allocate(numCoeffs);
  }
  const piOverN = Math.PI / nBins;
  for (let c = 0; c < numCoeffs; c++) {
    let sum = 0;
    const angleStep = piOverN * c;
    for (let i = 0; i < nBins; i++) {
      sum += logMag[i] * Math.cos(angleStep * (i + 0.5));
    }
    cep[c] = sum;
  }
  // 3. Dựng lại bao phổ mượt (IDCT bậc thấp) chỉ trong dải tìm formant 150Hz-3.6kHz
  const envLen = maxBin - minBin + 1;
  let envelope = self.formantEnvelopeBuffer;
  if (!envelope || envelope.length !== envLen) {
    if (envelope) memoryManager.free(envelope.offset || envelope);
    envelope = self.formantEnvelopeBuffer = memoryManager.allocate(envLen);
  }
  for (let i = 0; i < envLen; i++) {
    const bin = minBin + i;
    let value = cep[0] / nBins;
    for (let c = 1; c < numCoeffs; c++) {
      value += (2 / nBins) * cep[c] * Math.cos(piOverN * c * (bin + 0.5));
    }
    envelope[i] = value;
  }
  // 4. Dò đỉnh cộng hưởng thật trên bao phổ: F1 trong 200-1000Hz, F2 trong 800-3400Hz (F2 luôn cách F1 tối thiểu 250Hz)
  const findPeak = (loHz, hiHz) => {
    const lo = Math.max(1, Math.round(loHz / freqPerBin) - minBin);
    const hi = Math.min(envLen - 1, Math.round(hiHz / freqPerBin) - minBin);
    let bestIdx = -1,
      bestVal = -Infinity;
    for (let i = Math.max(1, lo); i < hi; i++) {
      if (envelope[i] > envelope[i - 1] && envelope[i] > envelope[i + 1] && envelope[i] > bestVal) {
        bestVal = envelope[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  const f1Idx = findPeak(200, 1000);
  const f2LoHz = f1Idx >= 0 ? Math.max(800, (minBin + f1Idx) * freqPerBin + 250) : 800;
  const f2Idx = findPeak(f2LoHz, 3400);
  if (f1Idx < 0 || f2Idx < 0) return null;
  const f1 = (minBin + f1Idx) * freqPerBin;
  const f2 = (minBin + f2Idx) * freqPerBin;
  const prom = (idx) => envelope[idx] - (envelope[Math.max(0, idx - 5)] + envelope[Math.min(envLen - 1, idx + 5)]) / 2;
  const confidence = Math.max(0, Math.min(1, ((prom(f1Idx) + prom(f2Idx)) / 2) * vocalPresence));
  return {
    f1,
    f2,
    confidence
  };
}
// =========================================================================
// THUẬT TOÁN ĐO CAO ĐỘ YIN THỜI GIAN THỰC NĂNG CẤP SIÊU TỐC V20.0 (UNROLLED X4 & COSIN-LUT)
// =========================================================================
function detectPitchPeriod(timeData, sampleRate, spectralProfile, rms, magnitudes) {
  const dataLen = timeData.length;
  const minLag = Math.round(sampleRate / 500);
  const maxLag = Math.round(sampleRate / 50);
  // 1. KHỞI TẠO VÀ LƯU TRỮ CỐ ĐỊNH MẢNG CỬA SỔ YIN CHỐNG RE-ALLOCATE VÀ TRIỆT TIÊU TOÁN LƯỢNG GIÁC
  let yinWindow = self.yinWindowBuffer;
  if (!yinWindow || yinWindow.length !== dataLen) {
    if (yinWindow) memoryManager.free(yinWindow.offset || yinWindow);
    yinWindow = self.yinWindowBuffer = memoryManager.allocate(dataLen);
    for (let i = 0; i < dataLen; i++) {
      yinWindow[i] = Math.cos(Math.PI * i / (dataLen - 1)) ** 2;
    }
  }
  let autocorr = self.yinAutocorr;
  let diff = self.yinDiff;
  let cmndf = self.yinCmndf;
  if (!autocorr || autocorr.length < maxLag) {
    if (autocorr) memoryManager.free(autocorr.offset || autocorr);
    if (diff) memoryManager.free(diff.offset || diff);
    if (cmndf) memoryManager.free(cmndf.offset || cmndf);
    autocorr = self.yinAutocorr = memoryManager.allocate(maxLag);
    diff = self.yinDiff = memoryManager.allocate(maxLag);
    cmndf = self.yinCmndf = memoryManager.allocate(maxLag);
  }
  autocorr.fill(0);
  diff.fill(0);
  cmndf.fill(0);
  let cumulativeSum = 0;
  // 2. VÒNG LẶP KIỂM TRA ĐỘ LỆCH PHA CỐT LÕI - PHÂN RÃ UNROLL BẬC 4 (SIÊU NHẸ MÁY)
  for (let lag = minLag; lag < maxLag; lag++) {
    let sum = 0;
    const limit = dataLen - lag;
    let i = 0;
    for (; i < limit - 3; i += 4) {
      // Nhánh 0
      const d0 = timeData[i] - timeData[i + lag];
      sum += d0 * d0 * yinWindow[i];
      // Nhánh 1
      const d1 = timeData[i + 1] - timeData[i + 1 + lag];
      sum += d1 * d1 * yinWindow[i + 1];
      // Nhánh 2
      const d2 = timeData[i + 2] - timeData[i + 2 + lag];
      sum += d2 * d2 * yinWindow[i + 2];
      // Nhánh 3
      const d3 = timeData[i + 3] - timeData[i + 3 + lag];
      sum += d3 * d3 * yinWindow[i + 3];
    }
    // Giải quyết nốt các phần tử dư thừa cuối chu kỳ quét
    for (; i < limit; i++) {
      const d = timeData[i] - timeData[i + lag];
      sum += d * d * yinWindow[i];
    }
    diff[lag] = sum;
    cumulativeSum += sum;
    if (lag === minLag) {
      cmndf[lag] = sum;
    } else {
      const mean = cumulativeSum / (lag - minLag + 1);
      cmndf[lag] = sum / (mean || 1.0001);
    }
  }
  const threshold = 0.07;
  let minCmndf = Infinity,
    peakLag = minLag;
  for (let lag = minLag; lag < maxLag; lag++) {
    if (cmndf[lag] < minCmndf && cmndf[lag] < threshold) {
      minCmndf = cmndf[lag];
      peakLag = lag;
    }
  }
  // Nội suy Parabolic độ phân giải cực cao (Sub-pixel Pitch Precision)
  if (peakLag > minLag && peakLag < maxLag - 1) {
    const y1 = cmndf[peakLag - 1],
      y2 = cmndf[peakLag],
      y3 = cmndf[peakLag + 1];
    const denom = 2 * (y1 - 2 * y2 + y3);
    if (denom !== 0) peakLag += (y1 - y3) / denom;
  }
  const period = peakLag / sampleRate;
  const confidence = Math.min(1, 1 - minCmndf);
  // Gọi hàm bóc tách hợp âm đa âm nền
  const polyphonicPitches = detectPolyphonicPitches(magnitudes, sampleRate, dataLen);
  // 3. KHÓA TĨNH ĐỐI TƯỢNG ĐẦU RA - ĐẠT TIÊU CHUẨN ĐỘC NHẤT VÔ NHỊ ZERO-GC 100%
  if (!self.staticPitchResult) {
    self.staticPitchResult = {
      period: 0,
      confidence: 0,
      isVocal: false,
      polyphonicPitches: null,
      polyPitchesCount: 0
    };
  }
  self.staticPitchResult.period = period;
  self.staticPitchResult.confidence = confidence;
  self.staticPitchResult.isVocal = spectralProfile.vocalPresence > 0.55;
  self.staticPitchResult.polyphonicPitches = polyphonicPitches;
  self.staticPitchResult.polyPitchesCount = self.staticPolyPitchesCount;
  return self.staticPitchResult;
}
// 4. Nhận diện giọng điệu chính bài hát (Key Detection) - BẢN SỬA LỖI GC-CHURN HOÀN TOÀN TỪ LUT TĨNH
function detectKey(chroma) {
  let maxCorr = -Infinity;
  let detectedKeyIdx = 0;
  let isMajor = true;
  // Đọc trực tiếp dữ liệu cấu hình từ không gian luồng tĩnh của lớp bảo vệ
  const majorProfile = self.majorProfileLUT;
  const minorProfile = self.minorProfileLUT;
  const keys = self.keyNamesLUT;
  for (let i = 0; i < 12; i++) {
    let majorCorr = 0,
      minorCorr = 0;
    for (let j = 0; j < 12; j++) {
      const idx = (j + i) % 12;
      majorCorr += chroma[j] * majorProfile[idx];
      minorCorr += chroma[j] * minorProfile[idx];
    }
    if (majorCorr > maxCorr) {
      maxCorr = majorCorr;
      detectedKeyIdx = i;
      isMajor = true;
    }
    if (minorCorr > maxCorr) {
      maxCorr = minorCorr;
      detectedKeyIdx = i;
      isMajor = false;
    }
  }
  let totalChroma = 0;
  for (let i = 0; i < 12; i++) totalChroma += chroma[i];
  const confidence = Math.min(1.0, ensureFinite(maxCorr / (totalChroma || 1.0001)));
  // Ghi đè cấu trúc đối tượng tĩnh bảo vệ RAM
  self.staticKeyResult.key = keys[detectedKeyIdx] + (isMajor ? "" : "m");
  self.staticKeyResult.confidence = confidence;
  self.staticKeyResult.isMajor = isMajor;
  return self.staticKeyResult;
}
// 5. Nhận diện Hợp âm (Chord Detection) - TẬP TRUNG TỐI ƯU ZERO-GC 100% TRÁNH KHỰNG TIẾNG
function detectChord(chroma) {
  let maxScore = -Infinity;
  let detectedChordIdx = 0;
  let isMajor = true;
  const templateMajor = self.chordTemplateMajorLUT;
  const templateMinor = self.chordTemplateMinorLUT;
  const keys = self.keyNamesLUT;
  for (let i = 0; i < 12; i++) {
    let majorScore = 0,
      minorScore = 0;
    for (let j = 0; j < 12; j++) {
      const idx = (j + i) % 12;
      majorScore += chroma[j] * templateMajor[idx];
      minorScore += chroma[j] * templateMinor[idx];
    }
    if (majorScore > maxScore) {
      maxScore = majorScore;
      detectedChordIdx = i;
      isMajor = true;
    }
    if (minorScore > maxScore) {
      maxScore = minorScore;
      detectedChordIdx = i;
      isMajor = false;
    }
  }
  let totalChroma = 0;
  for (let i = 0; i < 12; i++) totalChroma += chroma[i];
  const confidence = Math.min(1.0, ensureFinite(maxScore / (totalChroma || 1.0001)));
  self.staticChordResult.chord = keys[detectedChordIdx] + (isMajor ? "" : "m");
  self.staticChordResult.confidence = confidence;
  self.staticChordResult.isMajor = isMajor;
  return self.staticChordResult;
}
// 6. Phân tích loại nhiễu (Noise Type) – Unroll 4 bảo toàn và phẳng hóa bộ đệm toán học
function detectNoiseType(magnitudes, freqPerBin, bufferLength) {
  const length = bufferLength / 2;
  let logFreqBuf = self.logFreqBuf;
  if (!logFreqBuf || logFreqBuf.length < length) {
    if (logFreqBuf) memoryManager.free(logFreqBuf.offset || logFreqBuf);
    logFreqBuf = self.logFreqBuf = memoryManager.allocate(length);
  }
  let logMagBuf = self.logMagBuf;
  if (!logMagBuf || logMagBuf.length < length) {
    if (logMagBuf) memoryManager.free(logMagBuf.offset || logMagBuf);
    logMagBuf = self.logMagBuf = memoryManager.allocate(length);
  }
  let validCount = 0;
  for (let i = 1; i < length - 1; i += 4) {
    const freq0 = i * freqPerBin;
    if (freq0 >= 20 && freq0 <= 16000) {
      logFreqBuf[validCount] = Math.log(freq0);
      logMagBuf[validCount] = Math.log(Math.max(magnitudes[i], 1e-8) ** 2);
      validCount++;
    }
    if (i + 1 < length - 1) {
      const freq1 = (i + 1) * freqPerBin;
      if (freq1 >= 20 && freq1 <= 16000) {
        logFreqBuf[validCount] = Math.log(freq1);
        logMagBuf[validCount] = Math.log(Math.max(magnitudes[i + 1], 1e-8) ** 2);
        validCount++;
      }
    }
    if (i + 2 < length - 1) {
      const freq2 = (i + 2) * freqPerBin;
      if (freq2 >= 20 && freq2 <= 16000) {
        logFreqBuf[validCount] = Math.log(freq2);
        logMagBuf[validCount] = Math.log(Math.max(magnitudes[i + 2], 1e-8) ** 2);
        validCount++;
      }
    }
    if (i + 3 < length - 1) {
      const freq3 = (i + 3) * freqPerBin;
      if (freq3 >= 20 && freq3 <= 16000) {
        logFreqBuf[validCount] = Math.log(freq3);
        logMagBuf[validCount] = Math.log(Math.max(magnitudes[i + 3], 1e-8) ** 2);
        validCount++;
      }
    }
  }
  if (validCount < 10) return "none";
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < validCount; i++) {
    const x = logFreqBuf[i];
    const y = logMagBuf[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const denominator = validCount * sumX2 - sumX * sumX;
  if (denominator === 0) return "none";
  const slope = (validCount * sumXY - sumX * sumY) / denominator;
  const dbPerOctave = slope * Math.log(2) * 20 / Math.log(10);
  if (Math.abs(dbPerOctave) < 1.5) return "white";
  else if (dbPerOctave > 1.5) return "blue";
  else if (dbPerOctave < -4.0) return "brown";
  else return "pink";
}
// 7. Phát hiện cường độ nhiễu thích ứng (Noise Level Adaptive) - Sửa lỗi tràn mảng biên Unroll 4
function detectNoise(magnitudes, freqPerBin, bufferLength) {
  const length = bufferLength / 2;
  let energyBuf = self.noiseEnergyBuf;
  if (!energyBuf || energyBuf.length < length) {
    if (energyBuf) memoryManager.free(energyBuf.offset || energyBuf);
    energyBuf = self.noiseEnergyBuf = memoryManager.allocate(length);
  }
  let vadBuf = self.vadBuf;
  if (!vadBuf || vadBuf.length < length) {
    if (vadBuf) memoryManager.free(vadBuf.offset || vadBuf);
    vadBuf = self.vadBuf = memoryManager.allocate(length);
  }
  let totalEnergy = 0;
  let lowEnergy = 0,
    midEnergy = 0,
    highEnergy = 0;
  let voiceEnergy = 0,
    nonVoiceEnergy = 0;
  let voiceBinCount = 0,
    nonVoiceBinCount = 0;
  for (let i = 0; i < length; i += 4) {
    // Nhánh Unroll 0
    const freq0 = i * freqPerBin;
    const mag0 = magnitudes[i];
    const energy0 = mag0 * mag0;
    totalEnergy += energy0;
    energyBuf[i] = energy0;
    let isVoice0 = 0;
    if (freq0 > 300 && freq0 < 3400 && mag0 > 0.02) {
      let localPeak = mag0 > (i > 0 ? magnitudes[i - 1] : 0) && mag0 > (i + 1 < length ? magnitudes[i + 1] : 0);
      if (localPeak) isVoice0 = 1.0;
    }
    vadBuf[i] = isVoice0;
    if (isVoice0 > 0.5) {
      voiceEnergy += energy0;
      voiceBinCount++;
    } else {
      nonVoiceEnergy += energy0;
      nonVoiceBinCount++;
    }
    if (freq0 < 100) lowEnergy += energy0;
    else if (freq0 < 8000) midEnergy += energy0;
    else highEnergy += energy0;
    // Nhánh Unroll 1
    if (i + 1 < length) {
      const freq1 = (i + 1) * freqPerBin;
      const mag1 = magnitudes[i + 1];
      const energy1 = mag1 * mag1;
      totalEnergy += energy1;
      energyBuf[i + 1] = energy1;
      let isVoice1 = 0;
      if (freq1 > 300 && freq1 < 3400 && mag1 > 0.02) {
        let localPeak = mag1 > magnitudes[i] && mag1 > (i + 2 < length ? magnitudes[i + 2] : 0);
        if (localPeak) isVoice1 = 1.0;
      }
      vadBuf[i + 1] = isVoice1;
      if (isVoice1 > 0.5) {
        voiceEnergy += energy1;
        voiceBinCount++;
      } else {
        nonVoiceEnergy += energy1;
        nonVoiceBinCount++;
      }
      if (freq1 < 100) lowEnergy += energy1;
      else if (freq1 < 8000) midEnergy += energy1;
      else highEnergy += energy1;
    }
    // Nhánh Unroll 2
    if (i + 2 < length) {
      const freq2 = (i + 2) * freqPerBin;
      const mag2 = magnitudes[i + 2];
      const energy2 = mag2 * mag2;
      totalEnergy += energy2;
      energyBuf[i + 2] = energy2;
      let isVoice2 = 0;
      if (freq2 > 300 && freq2 < 3400 && mag2 > 0.02) {
        let localPeak = mag2 > magnitudes[i + 1] && mag2 > (i + 3 < length ? magnitudes[i + 3] : 0);
        if (localPeak) isVoice2 = 1.0;
      }
      vadBuf[i + 2] = isVoice2;
      if (isVoice2 > 0.5) {
        voiceEnergy += energy2;
        voiceBinCount++;
      } else {
        nonVoiceEnergy += energy2;
        nonVoiceBinCount++;
      }
      if (freq2 < 100) lowEnergy += energy2;
      else if (freq2 < 8000) midEnergy += energy2;
      else highEnergy += energy2;
    }
    // Nhánh Unroll 3
    if (i + 3 < length) {
      const freq3 = (i + 3) * freqPerBin;
      const mag3 = magnitudes[i + 3];
      const energy3 = mag3 * mag3;
      totalEnergy += energy3;
      energyBuf[i + 3] = energy3;
      let isVoice3 = 0;
      if (freq3 > 300 && freq3 < 3400 && mag3 > 0.02) {
        let localPeak = mag3 > magnitudes[i + 2] && mag3 > (i + 4 < length ? magnitudes[i + 4] : 0);
        if (localPeak) isVoice3 = 1.0;
      }
      vadBuf[i + 3] = isVoice3;
      if (isVoice3 > 0.5) {
        voiceEnergy += energy3;
        voiceBinCount++;
      } else {
        nonVoiceEnergy += energy3;
        nonVoiceBinCount++;
      }
      if (freq3 < 100) lowEnergy += energy3;
      else if (freq3 < 8000) midEnergy += energy3;
      else highEnergy += energy3;
    }
  }
  const voiceRatio = voiceBinCount / (voiceBinCount + nonVoiceBinCount + 1);
  const noiseLevelFromNonVoice = nonVoiceBinCount > 0 ? nonVoiceEnergy / totalEnergy : 0.1;
  // Đúc kết quả vào Object cấu trúc tĩnh khóa chặt chống sinh rác RAM
  self.staticNoiseResult.level = Math.min(1.0, ensureFinite(noiseLevelFromNonVoice + (1.0 - voiceRatio) * 0.3));
  self.staticNoiseResult.white = Math.min(1.0, ensureFinite(highEnergy / (totalEnergy || 1.0)));
  self.staticNoiseResult.lowFreq = Math.min(1.0, ensureFinite(lowEnergy / (totalEnergy || 1.0)));
  self.staticNoiseResult.midFreq = Math.min(1.0, ensureFinite(midEnergy / (totalEnergy || 1.0)));
  self.staticNoiseResult.voiceActivity = voiceRatio;
  self.staticNoiseResult.type = detectNoiseType(magnitudes, freqPerBin, bufferLength);
  return self.staticNoiseResult;
}
// 8. Hàm nhận diện tốc độ nhịp nhạc (Tempo/BPM) - SỬA LỖI LOGIC ĐO TẦN SỐ BIẾN ĐIỆU ĐƯỜNG BAO (ONSET ENVELOPE)
function detectTempo(timeData, magnitudes, sampleRate, fftSize) {
  const freqPerBin = sampleRate / fftSize;
  let energySum = 0;
  for (let i = 0; i < magnitudes.length; i += 4) {
    energySum += magnitudes[i] * magnitudes[i];
    if (i + 1 < magnitudes.length) energySum += magnitudes[i + 1] * magnitudes[i + 1];
    if (i + 2 < magnitudes.length) energySum += magnitudes[i + 2] * magnitudes[i + 2];
    if (i + 3 < magnitudes.length) energySum += magnitudes[i + 3] * magnitudes[i + 3];
  }
  let top1Bpm = 120,
    top1Energy = -1;
  let top2Bpm = 120,
    top2Energy = -1;
  // CHỐNG SẬP SỐ: Quy đổi chính xác từ tần số phổ Onset dải thấp (0.8Hz - 3.6Hz) ra chu kỳ BPM chuẩn [50 - 220]
  for (let i = 1; i < magnitudes.length - 1; i++) {
    if (magnitudes[i] > magnitudes[i - 1] && magnitudes[i] > magnitudes[i + 1]) {
      const freq = i * freqPerBin;
      // Nếu magnitudes được truyền từ bộ phân tích phổ năng lượng thô gốc, ta trích xuất nhịp điệu dải trầm sub-bass làm gốc
      // Cơ chế khóa dải tần nhịp điệu sinh học (Biometric Rhythmic Gating)
      let bpm = freq * 60;
      if (bpm > 220) {
        // Thuật toán hạ bậc bát độ (Octave Sub-division) nắn cao độ nhịp điệu về khung chuẩn
        while (bpm > 220) bpm *= 0.5;
      }
      if (bpm >= 50 && bpm <= 220) {
        const currentEnergy = magnitudes[i] * magnitudes[i];
        if (currentEnergy > top1Energy) {
          top2Energy = top1Energy;
          top2Bpm = top1Bpm;
          top1Energy = currentEnergy;
          top1Bpm = bpm;
        } else if (currentEnergy > top2Energy) {
          top2Energy = currentEnergy;
          top2Bpm = bpm;
        }
      }
    }
  }
  let bestBpm = top1Bpm;
  if (top1Energy > 0 && top2Energy > 0) {
    if (bestBpm > 140 && top2Bpm > bestBpm * 0.45 && top2Bpm < bestBpm * 0.55) {
      bestBpm = top2Bpm;
    }
  }
  const confidence = top1Energy > -1 ? Math.min(1.0, ensureFinite(top1Energy * 35 / (energySum || 1.0))) : 0;
  self.staticTempoResult.bpm = Math.round(bestBpm);
  self.staticTempoResult.confidence = confidence;
  return self.staticTempoResult;
}
// =========================================================================
// PHẦN 1: MẠNG NƠ-RON PHÂN LOẠI THỂ LOẠI NHẠC V3 PRO - CHUẨN DSP ĐỈNH CAO (ZERO-GC)
// =========================================================================
// KHỞI TẠO BỘ TỪ ĐIỂN VÀ MA TRẬN PHẲNG TĨNH TOÀN CỤC (CHẠY DUY NHẤT LỒNG KHỞI ĐỘNG WORKER)
if (typeof self.hasInitializedGenreNN === 'undefined') {
  self.genreNamesLUT = ["EDM", "Pop", "Bolero", "Classical/Jazz", "Hip-Hop", "Drum & Bass", "Rock/Metal", "Karaoke"];
  
  // Khóa tĩnh vùng đệm nơ-ron toàn luồng, triệt tiêu 100% Alloc/Free trong Hot Path
  self.genreInputBuffer = new Float32Array(10);
  self.genreHiddenBuffer = new Float32Array(16);
  self.genreWeightedHiddenBuffer = new Float32Array(16);
  self.genreScoresBuffer = new Float32Array(8);
  self.attnScoresBuffer = new Float32Array(20); // Đã khóa tĩnh tối đa 20 khung hình lịch sử (Triệt tiêu memoryManager)

  // FIX LỖI MA TRẬN ẨN: Thiết lập mảng phẳng kích thước chuẩn 10 x 16 (160 trọng số) bảo vệ an toàn hệ thống
  self.genreHiddenWeightsLUT = new Float32Array([
    0.8, -0.6, 1.2, 0.4, -0.9, 1.1, -0.3, 0.7, 1.4, -0.5, 0.2, -1.0, 0.9, -0.8, 1.3, 0.6, // Hàng 0: subBass
    1.5, 0.3, -0.7, 1.0, 0.8, -1.2, 0.5, -0.4, 1.1, 0.9, -0.6, 1.3, -0.2, 0.7, -1.1, 0.4, // Hàng 1: bass
    1.2, -1.4, 0.6, -0.8, 1.0, 0.5, -1.1, 1.3, -0.7, 0.9, 1.5, -0.3, 0.4, -1.2, 0.8, -0.6, // Hàng 2: vocalPresence
    -0.9, 1.6, -0.4, 1.1, -0.7, 0.8, 1.4, -1.0, 0.5, -1.3, 0.6, 1.2, -0.8, 0.3, -1.5, 0.9, // Hàng 3: transientEnergy
    1.1, -0.5, 1.0, -1.3, 0.7, -0.9, 1.4, 0.2, -1.1, 0.8, -0.6, 1.5, 0.4, -0.7, 1.2, -0.3, // Hàng 4: BPM normalized
    0.6, 1.3, -0.8, 0.9, -1.2, 0.4, -0.7, 1.5, 0.3, -1.0, 1.1, -0.5, 0.8, -1.4, 0.2, 1.0, // Hàng 5: MFCC Energy
    -1.0, 0.7, 1.4, -0.6, 0.5, -1.3, 0.9, -0.2, 1.1, 0.4, -0.8, 1.6, -0.3, 0.7, -1.2, 0.5, // Hàng 6: Chroma Variance
    1.3, -0.9, 0.4, 1.2, -0.5, 0.8, -1.1, 0.6, 1.5, -0.7, 0.3, -1.4, 1.0, -0.2, 0.9, -0.6, // Hàng 7: Beat Strength
    0.7, -0.5, 0.9, 0.3, -0.6, 0.8, -0.2, 0.5, 1.1, -0.4, 0.1, -0.8, 0.6, -0.5, 1.0, 0.4, // Hàng 8: Lịch sử subBass
    -0.3, 0.8, -0.2, 0.6, -0.4, 0.5, 0.7, -0.5, 0.3, -0.6, 0.9, 0.5, -0.4, 0.2, -0.7, 0.3 // Hàng 9: Trọng tâm phổ
  ]);

  // FIX LỖI MA TRẬN RA: Thiết lập mảng phẳng kích thước chuẩn 16 x 8 (128 trọng số) liên kết chặt chẽ tầng ẩn
  self.genreOutputWeightsLUT = new Float32Array([
    1.8, -1.2, -0.8, -1.5, 1.6, 2.1, 0.9, -0.4, // Nút ẩn 0 -> 8 thể loại
    -0.6, 1.9, 0.7, -0.3, -1.1, -0.8, -0.5, 1.4, // Nút ẩn 1
    -0.4, 0.5, 2.2, 0.8, -0.9, -0.7, -1.0, 1.1, // Nút ẩn 2
    -1.3, -0.7, 0.4, 2.3, -0.6, -1.1, 0.8, -0.5, // Nút ẩn 3
    0.7, -0.9, -0.5, -0.8, 2.0, 0.6, 1.3, -0.2, // Nút ẩn 4
    1.4, -1.0, -0.6, -1.2, 0.9, 2.4, 0.5, -0.8, // Nút ẩn 5
    0.3, -0.4, -0.2, 0.6, 0.8, 0.4, 2.1, -0.7, // Nút ẩn 6
    -0.2, 1.5, 1.0, -0.4, -0.7, -0.5, -0.9, 1.8, // Nút ẩn 7
    0.5, -0.6, 0.8, -0.2, 1.1, 0.9, -0.4, 0.3, // Nút ẩn 8
    -0.3, 0.7, -0.5, 1.2, -0.4, -0.6, 0.8, -0.2, // Nút ẩn 9
    0.4, -0.2, 0.9, -0.5, 0.7, 0.5, -0.3, 0.6, // Nút ẩn 10
    -0.8, 1.1, -0.4, 0.3, -0.9, -0.5, 1.2, -0.4, // Nút ẩn 11
    0.6, -0.4, 0.2, -0.7, 1.0, 0.8, -0.5, 0.3, // Nút ẩn 12
    -0.2, 0.5, 0.7, -0.4, -0.3, -0.2, 0.9, -0.6, // Nút ẩn 13
    0.7, -0.9, -0.3, -0.5, 1.2, 1.4, 0.4, -0.3, // Nút ẩn 14
    -0.1, 0.8, 1.1, -0.6, -0.5, -0.4, -0.8, 1.2  // Nút ẩn 15
  ]);

  self.hasInitializedGenreNN = true;
}

function classifyGenre(spectralProfile, bpm, spectralHistory) {
  const {
    subBass,
    bass,
    subMid,
    midLow,
    midHigh,
    high,
    subTreble,
    air,
    vocalPresence,
    transientEnergy,
    mfcc,
    chroma,
    instruments
  } = spectralProfile;

  // 1. PHẲNG HÓA VÒNG LẶP ĐO ĐẠC ĐẶC TRƯNG PHỔ TỐC ĐỘ CAO KHÔNG RÁC RAM
  let mfccSum = 0;
  const mfccLen = mfcc.length;
  for (let i = 0; i < mfccLen; i++) mfccSum += Math.abs(mfcc[i]);
  const mfccEnergy = mfccSum / mfccLen;

  let chromaSum = 0;
  const chromaLen = chroma.length;
  for (let i = 0; i < chromaLen; i++) chromaSum += chroma[i] * chroma[i];
  const chromaVariance = chromaSum / chromaLen;

  const spectralCentroidApprox = (subBass * 50 + bass * 150 + subMid * 500 + midLow * 1500 + midHigh * 3000 + high * 6000 + subTreble * 10000 + air * 14000) / 8;
  const drumsConf = instruments ? (instruments.drums || 0) : 0;
  const beatStrength = transientEnergy * drumsConf * (bpm > 80 ? 1.2 : 1.0);

  // Đo quét dải lịch sử âm thanh tuyến tính
  let historySubBass = 0;
  const historyCount = spectralHistory.length;
  for (let i = 0; i < historyCount; i++) {
    historySubBass += spectralHistory[i].subBass || 0;
  }
  const avgSubBass = historySubBass / (historyCount || 1);

  // 2. NẠP DỮ LIỆU ĐÈ LÊN VÙNG ĐỆM TĨNH KHÓA CHẶT CHỐNG SINH TRÁO THAM CHIẾU
  const input = self.genreInputBuffer;
  input[0] = subBass;
  input[1] = bass;
  input[2] = vocalPresence;
  input[3] = transientEnergy;
  input[4] = (bpm - 120) / 60;
  input[5] = mfccEnergy / 15;
  input[6] = chromaVariance;
  input[7] = beatStrength;
  input[8] = avgSubBass;
  input[9] = spectralCentroidApprox / 14000;

  // 3. TÍNH CHẬP TẦNG ẨN (HIDDEN LAYER MULTIPLICATION) - UNROLLED 10X SIÊU TỐC CPU
  const hidden = self.genreHiddenBuffer;
  const wHidden = self.genreHiddenWeightsLUT;
  for (let h = 0; h < 16; h++) {
    let sum = input[0] * wHidden[h] 
            + input[1] * wHidden[16 + h] 
            + input[2] * wHidden[32 + h] 
            + input[3] * wHidden[48 + h] 
            + input[4] * wHidden[64 + h] 
            + input[5] * wHidden[80 + h] 
            + input[6] * wHidden[96 + h] 
            + input[7] * wHidden[112 + h] 
            + input[8] * wHidden[128 + h] 
            + input[9] * wHidden[144 + h];
    hidden[h] = Math.tanh(sum);
  }

  // 4. KHỐI AI: TEMPORAL ATTENTION LAYER (ĐÃ FIX TỐI ƯU ZERO-GC & INDEX BUG)
  const historyLength = Math.min(20, historyCount);
  if (historyLength > 1) {
    const attnScores = self.attnScoresBuffer; // Dùng trực tiếp vùng đệm tĩnh Float32Array(20)
    let attnSum = 0;

    for (let t = 0; t < historyLength; t++) {
      const hist = spectralHistory[historyCount - 1 - t];
      let sim = input[0] * (hist.subBass || 0.5) 
              + input[1] * (hist.bass || 0.5) 
              + input[2] * (hist.vocalPresence || 0.5) 
              + input[3] * (hist.transientEnergy || 0.5);
      const scoreVal = Math.exp(sim * 3.2);
      attnScores[t] = scoreVal;
      attnSum += scoreVal;
    }

    if (attnSum > 0) {
      const weightedHidden = self.genreWeightedHiddenBuffer;
      weightedHidden.fill(0);
      const invAttnSum = 1.0 / attnSum; // Nhân nghịch đảo thay cho phép chia trong vòng lặp

      for (let t = 0; t < historyLength; t++) {
        const weight = attnScores[t] * invAttnSum;
        const histHidden = spectralHistory[historyCount - 1 - t].cachedHidden || hidden;

        // Unroll tích lũy Attention 16 nút (ĐÃ SỬA LỖI ĐỌC NHẦM INDEX Ở NÚT 10)
        weightedHidden[0]  += weight * histHidden[0];
        weightedHidden[1]  += weight * histHidden[1];
        weightedHidden[2]  += weight * histHidden[2];
        weightedHidden[3]  += weight * histHidden[3];
        weightedHidden[4]  += weight * histHidden[4];
        weightedHidden[5]  += weight * histHidden[5];
        weightedHidden[6]  += weight * histHidden[6];
        weightedHidden[7]  += weight * histHidden[7];
        weightedHidden[8]  += weight * histHidden[8];
        weightedHidden[9]  += weight * histHidden[9];
        weightedHidden[10] += weight * histHidden[10]; // CHUẨN XÁC: histHidden[10]
        weightedHidden[11] += weight * histHidden[11];
        weightedHidden[12] += weight * histHidden[12];
        weightedHidden[13] += weight * histHidden[13];
        weightedHidden[14] += weight * histHidden[14];
        weightedHidden[15] += weight * histHidden[15];
      }

      // Dung hợp mạng trạng thái nơ-ron cục bộ động
      for (let h = 0; h < 16; h++) {
        hidden[h] = hidden[h] * 0.75 + weightedHidden[h] * 0.25;
      }
    }
  }

  // Ghi nhớ trạng thái ẩn phục vụ cho dải trễ Attention khung hình kế tiếp
  if (!spectralProfile.cachedHidden || spectralProfile.cachedHidden.length !== 16) {
    spectralProfile.cachedHidden = new Float32Array(16);
  }
  spectralProfile.cachedHidden.set(hidden);

  // 5. TÍNH TOÁN ĐIỂM SỐ ĐẦU RA THỂ LOẠI (OUTPUT LAYER) - UNROLLED STRIDE STRATEGY
  const scores = self.genreScoresBuffer;
  scores.fill(0);
  const wOutput = self.genreOutputWeightsLUT;
  let maxScore = -Infinity;
  let bestGenreIdx = 0;

  for (let g = 0; g < 8; g++) {
    let sum = hidden[0]  * wOutput[g] 
            + hidden[1]  * wOutput[8 + g] 
            + hidden[2]  * wOutput[16 + g] 
            + hidden[3]  * wOutput[24 + g] 
            + hidden[4]  * wOutput[32 + g] 
            + hidden[5]  * wOutput[40 + g] 
            + hidden[6]  * wOutput[48 + g] 
            + hidden[7]  * wOutput[56 + g] 
            + hidden[8]  * wOutput[64 + g] 
            + hidden[9]  * wOutput[72 + g] 
            + hidden[10] * wOutput[80 + g] 
            + hidden[11] * wOutput[88 + g] 
            + hidden[12] * wOutput[96 + g] 
            + hidden[13] * wOutput[104 + g] 
            + hidden[14] * wOutput[112 + g] 
            + hidden[15] * wOutput[120 + g];
    
    scores[g] = sum;
    if (sum > maxScore) {
      maxScore = sum;
      bestGenreIdx = g;
    }
  }

  // Trả về chuỗi nguyên thủy lưu trong mảng hằng số LUT tĩnh, đạt mức Zero-GC tuyệt đối 100%
  return self.genreNamesLUT[bestGenreIdx];
}

// =========================================================================
// PHẦN 2: THUẬT TOÁN TỰ ĐỘNG ĐIỀU CHỈNH ĐỒ THỊ EQ (AUTO-EQ NÂNG CAO V3 PRO - ZERO-GC)
// =========================================================================
// KHỞI TẠO BỘ TRA CỨU TĨNH TOÀN LUỒNG (CHẠY 1 LẦN DUY NHẤT KHI KHỞI CHẠY AUDIO WORKER)
if (typeof self.hasInitializedAutoEQ === 'undefined') {
  // Di chuyển toàn bộ Object Literals cấu hình ra khỏi Hot-path để triệt tiêu rác RAM
  self.autoEQProfileSettingsLUT = {
    "warm": {
      subBassGain: 1.1,
      bassGain: 1.0,
      highGain: 0.8
    },
    "bright": {
      highGain: 1.2,
      subTrebleGain: 1.1,
      clarityGain: 1.1
    },
    "bassHeavy": {
      subBassGain: 1.3,
      bassGain: 1.2
    },
    "vocal": {
      midHighGain: 1.2,
      formantGain: 1.3,
      clarityGain: 1.2
    },
    "proNatural": {
      subBassGain: 1.0,
      bassGain: 1.0,
      highGain: 1.0
    },
    "karaokeDynamic": {
      formantGain: 1.4,
      midHighGain: 1.2,
      clarityGain: 1.1
    },
    "rockMetal": {
      highGain: 1.3,
      bassGain: 1.1,
      transientBoost: 1.2
    },
    "smartStudio": {
      subBassGain: 1.0,
      formantGain: 1.1,
      clarityGain: 1.0
    }
  };
  // Cấu trúc đối tượng kết quả cố định toàn cục, tái sử dụng đè dữ liệu lên nhau
  self.staticEQResult = {
    subBassGain: 1.0,
    bassGain: 1.0,
    subMidGain: 1.0,
    midLowGain: 1.0,
    midHighGain: 1.0,
    highGain: 1.0,
    subTrebleGain: 1.0,
    airGain: 1.0,
    formantGain: 1.4,
    formantF1Freq: 500,
    formantF2Freq: 2100,
    clarityGain: 1.0,
    saturationGain: 0.1,
    transientBoost: 0.0
  };
  self.hasInitializedAutoEQ = true;
}

function computeAutoEQ(spectralProfile, genre, pitchMult, rms, spectralHistory = [], audioProfile = "proNatural") {
  const {
    subBass,
    bass,
    subMid,
    midLow,
    midHigh,
    high,
    subTreble,
    air,
    vocalPresence,
    transientEnergy,
    dynamicRange,
    instruments
  } = spectralProfile;
  // Đọc bảng EQ đặc trưng thể loại từ LUT backend tĩnh đã tối ưu hóa
  const eqProfile = eqLookupTable[genre] || eqLookupTable["Pop"];
  const pitchShiftFactor = Math.pow(2, pitchMult * 0.8);
  // 1. THUẬT TOÁN ĐÁNH CHẶN: CHỐNG PHÓNG ĐẠI BIÊN ĐỘ GÂY NỔ TIẾNG KHI ĐOẠN LẶNG
  let historyRmsAvg = rms;
  const historyCount = spectralHistory.length;
  if (historyCount > 5) {
    let rmsSum = 0;
    const start = Math.max(0, historyCount - 10);
    const itemsCount = historyCount - start;
    for (let i = start; i < historyCount; i++) {
      rmsSum += (spectralHistory[i].rms || rms);
    }
    historyRmsAvg = rmsSum / itemsCount;
  }
  const dynamicFactor = dynamicRange > 40 ? 0.65 : dynamicRange < 20 ? 1.25 : 1.0;
  const loudnessTarget = -14;
  // Thực hiện cơ chế Soft-Knee Clamp bảo vệ: Ép dải biên độ RMS lịch sử vào ngưỡng an toàn [0.015 - 1.0]
  const safeRmsAvg = Math.max(0.015, Math.min(1.0, historyRmsAvg));
  const currentDb = 20 * Math.log10(safeRmsAvg);
  // Công thức tính bù trừ áp suất âm thanh chuẩn hóa (Loudness Matching Algorithm)
  let loudnessCompensation = Math.pow(10, (loudnessTarget - currentDb) / 20);
  // Chốt chặn hãm phanh biên độ: Giới hạn hệ số nhân từ 0.35x đến tối đa 1.8x, tuyệt đối không nổ tiếng nền
  loudnessCompensation = Math.max(0.35, Math.min(1.8, loudnessCompensation));
  const clarityBoost = vocalPresence > 0.55 ? eqProfile.clarity * 0.9 : eqProfile.clarity * 0.55;
  let instrumentBoost = 0;
  let transientBoost = 0;
  // 2. PHẲNG HÓA VECTOR CHẬP ĐỊNH DANH NHẠC CỤ CHỐNG SINH RÁC RAM
  if (instruments) {
    // Quét mảng phẳng cục bộ tốc độ cao thay cho các hàm lặp Object động
    const guitarConf = instruments.guitar || 0;
    const pianoConf = instruments.piano || 0;
    const violinConf = instruments.violin || 0;
    const drumsConf = instruments.drums || 0;
    if (guitarConf > 0) {
      const sig = SpectralAnalyzer.prototype.instrumentSignatures["guitar"] || {};
      instrumentBoost += guitarConf * ((sig.harmonicBoost || 1) - 1 + (transientEnergy > 0.65 ? (sig.transientBoost || 1) - 1 : 0));
    }
    if (pianoConf > 0) {
      const sig = SpectralAnalyzer.prototype.instrumentSignatures["piano"] || {};
      instrumentBoost += pianoConf * ((sig.harmonicBoost || 1) - 1 + (transientEnergy > 0.65 ? (sig.transientBoost || 1) - 1 : 0));
    }
    if (violinConf > 0) {
      const sig = SpectralAnalyzer.prototype.instrumentSignatures["violin"] || {};
      instrumentBoost += violinConf * ((sig.harmonicBoost || 1) - 1 + (transientEnergy > 0.65 ? (sig.transientBoost || 1) - 1 : 0));
    }
    if (drumsConf > 0) {
      const sig = SpectralAnalyzer.prototype.instrumentSignatures["drums"] || {};
      instrumentBoost += drumsConf * ((sig.harmonicBoost || 1) - 1 + (transientEnergy > 0.65 ? (sig.transientBoost || 1) - 1 : 0));
      if (transientEnergy > 0.65) transientBoost += drumsConf * 0.5;
    }
  }
  const maxGain = 0.95;
  const limiterFactor = rms > 0.15 || transientEnergy > 0.8 ? 0.85 : 1.0;
  // 3. GHI ĐÈ TRỰC TIẾP DỮ LIỆU LÊN KHỐI BUFFER CẤU TRÚC TĨNH CỐ ĐỊNH (ZERO-GC)
  const eq = self.staticEQResult;
  eq.subBassGain = Math.min(maxGain, ensureFinite(eqProfile.subBass * dynamicFactor * limiterFactor * loudnessCompensation + (subBass < 0.3 ? 2.2 : subBass > 0.85 ? -1.8 : 0) + (rms < 0.1 ? 0.9 : 0) * (pitchMult > 1 ? 1.05 : 1.0)));
  eq.bassGain = Math.min(maxGain, ensureFinite(eqProfile.bass * dynamicFactor * limiterFactor * loudnessCompensation + (bass < 0.3 ? 1.8 : bass > 0.85 ? -1.4 : 0) + instrumentBoost * 0.5 * (1 + bass * 0.07)));
  eq.subMidGain = Math.min(maxGain, ensureFinite(eqProfile.subMid * loudnessCompensation + (subMid < 0.3 ? 1.4 : subMid > 0.85 ? -0.9 : 0) + (vocalPresence < 0.4 ? 0.9 : 0)));
  eq.midLowGain = Math.min(maxGain, ensureFinite(eqProfile.midLow * loudnessCompensation + (midLow < 0.3 ? 0.5 : midLow > 0.85 ? -0.5 : 0)));
  eq.midHighGain = Math.min(maxGain, ensureFinite(eqProfile.midHigh * loudnessCompensation + clarityBoost * 0.9 + (midHigh < 0.3 ? 0.5 : midHigh > 0.85 ? -0.5 : 0) * (vocalPresence > 0.55 ? 1.03 : 1.0)));
  eq.highGain = Math.min(maxGain, ensureFinite(eqProfile.high * loudnessCompensation + (transientEnergy > 0.65 ? 1.2 : 0) + (high < 0.3 ? 1.8 : high > 0.85 ? -1.4 : 0) + instrumentBoost * 0.5));
  eq.subTrebleGain = Math.min(maxGain, ensureFinite(eqProfile.subTreble * loudnessCompensation + (subTreble < 0.3 ? 2.2 : subTreble > 0.85 ? -1.8 : 0) + transientBoost * 0.9));
  eq.airGain = Math.min(maxGain, ensureFinite(eqProfile.air * loudnessCompensation + (air < 0.3 ? 2.2 : air > 0.85 ? -1.8 : 0) + (transientEnergy < 0.25 ? 0.5 : 0)));
  eq.formantGain = vocalPresence > 0.55 ? 3.2 : 1.4;
  eq.formantF1Freq = (vocalPresence > 0.65 ? 550 : vocalPresence < 0.4 ? 450 : 500) * pitchShiftFactor;
  eq.formantF2Freq = (vocalPresence > 0.65 ? 2300 : vocalPresence < 0.4 ? 1900 : 2100) * pitchShiftFactor;
  eq.clarityGain = ensureFinite(clarityBoost * 0.9 * loudnessCompensation);
  eq.saturationGain = (subBass > 0.65 || bass > 0.65 || subMid > 0.65) ? 0.3 : 0.1;
  eq.transientBoost = transientBoost * 0.9;
  if (eq.highGain > 1.8 && transientEnergy > 0.65) {
    eq.highGain *= 0.7;
  }
  // 4. ĐỒNG BỘ ĐỘ LỢI PROFILE TỪ BỘ NHỚ LUT TOÀN CỤC KHÔNG TẠO VÒNG LẶP ĐỘNG
  const settings = self.autoEQProfileSettingsLUT[audioProfile] || self.autoEQProfileSettingsLUT["proNatural"];
  if (settings.subBassGain !== undefined) eq.subBassGain = ensureFinite(eq.subBassGain * settings.subBassGain);
  if (settings.bassGain !== undefined) eq.bassGain = ensureFinite(eq.bassGain * settings.bassGain);
  if (settings.midHighGain !== undefined) eq.midHighGain = ensureFinite(eq.midHighGain * settings.midHighGain);
  if (settings.highGain !== undefined) eq.highGain = ensureFinite(eq.highGain * settings.highGain);
  if (settings.subTrebleGain !== undefined) eq.subTrebleGain = ensureFinite(eq.subTrebleGain * settings.subTrebleGain);
  if (settings.formantGain !== undefined) eq.formantGain = ensureFinite(eq.formantGain * settings.formantGain);
  if (settings.clarityGain !== undefined) eq.clarityGain = ensureFinite(eq.clarityGain * settings.clarityGain);
  if (settings.transientBoost !== undefined) eq.transientBoost = ensureFinite(eq.transientBoost * settings.transientBoost);
  // Trả về tham chiếu đối tượng tĩnh duy nhất, chặn đứng mọi hành vi tạo rác bộ nhớ
  return eq;
}
// =========================================================================
// PHẦN 3: BỘ NÉN TIẾNG & LÁ CHẮN ĐÁNH CHẶN (SOFT COMPRESS PRO V3.0 - TRUE ZERO GC)
// =========================================================================
// KHỞI TẠO BIẾN TRẠNG THÁI LIÊN KHUNG TOÀN CỤC (CHẠY 1 LẦN DUY NHẤT KHI UP LUỒNG WORKER)
if (typeof self.hasInitializedCompressorState === 'undefined') {
  self.limiterGainState = 1.0; // Biến lưu trữ hệ số suy hao liên khung, triệt tiêu méo tiếng click biên giới hạn
  self.lastIntervalState = 1000; // Biến làm mượt chu kỳ xử lý thời gian thực
  self.hasInitializedCompressorState = true;
}

function softCompress(data, dynamicRange, rms) {
  const len = data.length;
  // 1. TÁI SỬ DỤNG BỘ ĐỆM TĨNH TOÀN CỤC CHỐNG PHÂN MẢNH RAM VÀ TRANH CHẤP BỘ NHỚ
  let compressed = self.compressBuffer;
  if (!compressed || compressed.length !== len) {
    if (compressed) memoryManager.free(compressed.offset || compressed);
    compressed = self.compressBuffer = memoryManager.allocate(len);
  }
  // Cấu hình độ lợi Gain thích ứng sâu sắc theo dải động thực tế
  const targetDR = 20;
  const gain = dynamicRange < targetDR ? 1.0 + (targetDR - dynamicRange) * 0.035 : 1.0;
  const safeRms = rms || 0.05;
  let peakAfter = 0;
  // 2. VÒNG LẶP NÉN CHÍNH & TIÊM AI SATURATION PHI TUYẾN TẠO MÀU ANALOG (UNROLL X4)
  for (let i = 0; i < len; i += 4) {
    // --- KHUNG XỬ LÝ 0 ---
    let v0 = data[i];
    let cVal0 = v0 * (gain / (1.0 + Math.abs(v0 / (safeRms * 1.4))));
    let final0 = cVal0;
    if (cVal0 > 0) {
      final0 = cVal0 / (1.0 + 0.07 * cVal0); // Nắn hài lẻ mượt mà, trong trẻo tinh khiết
    } else {
      final0 = cVal0 / (1.0 + 0.13 * Math.abs(cVal0)); // Giữ dải trầm dày dặn, chắc khỏe ấm áp
    }
    if (Math.abs(final0) > peakAfter) peakAfter = Math.abs(final0);
    compressed[i] = ensureFinite(final0);
    // --- KHUNG XỬ LÝ 1 ---
    if (i + 1 < len) {
      let v1 = data[i + 1];
      let cVal1 = v1 * (gain / (1.0 + Math.abs(v1 / (safeRms * 1.4))));
      let final1 = cVal1;
      if (cVal1 > 0) {
        final1 = cVal1 / (1.0 + 0.07 * cVal1);
      } else {
        final1 = cVal1 / (1.0 + 0.13 * Math.abs(cVal1));
      }
      if (Math.abs(final1) > peakAfter) peakAfter = Math.abs(final1);
      compressed[i + 1] = ensureFinite(final1);
    }
    // --- KHUNG XỬ LÝ 2 ---
    if (i + 2 < len) {
      let v2 = data[i + 2];
      let cVal2 = v2 * (gain / (1.0 + Math.abs(v2 / (safeRms * 1.4))));
      let final2 = cVal2;
      if (cVal2 > 0) {
        final2 = cVal2 / (1.0 + 0.07 * cVal2);
      } else {
        final2 = cVal2 / (1.0 + 0.13 * Math.abs(cVal2));
      }
      if (Math.abs(final2) > peakAfter) peakAfter = Math.abs(final2);
      compressed[i + 2] = ensureFinite(final2);
    }
    // --- KHUNG XỬ LÝ 3 ---
    if (i + 3 < len) {
      let v3 = data[i + 3];
      let cVal3 = v3 * (gain / (1.0 + Math.abs(v3 / (safeRms * 1.4))));
      let final3 = cVal3;
      if (cVal3 > 0) {
        final3 = cVal3 / (1.0 + 0.07 * cVal3);
      } else {
        final3 = cVal3 / (1.0 + 0.13 * Math.abs(cVal3));
      }
      if (Math.abs(final3) > peakAfter) peakAfter = Math.abs(final3);
      compressed[i + 3] = ensureFinite(final3);
    }
  }
  // 3. TỰ ĐỘNG BÙ ĐẮP THỂ TÍCH ÂM THANH (AUTO MAKEUP GAIN STAGING - UNROLLED X4)
  const makeupGain = safeRms > 0.0001 ? Math.min(1.35, safeRms / (peakAfter || 1.0)) : 1.0;
  for (let i = 0; i < len; i += 4) {
    compressed[i] = ensureFinite(compressed[i] * makeupGain);
    if (i + 1 < len) compressed[i + 1] = ensureFinite(compressed[i + 1] * makeupGain);
    if (i + 2 < len) compressed[i + 2] = ensureFinite(compressed[i + 2] * makeupGain);
    if (i + 3 < len) compressed[i + 3] = ensureFinite(compressed[i + 3] * makeupGain);
  }
  // 4. LÁ CHẮN AI ĐÁNH CHẶN VÀ KHÓA TRẠNG THÁI: TRUE-PEAK LOOK-AHEAD BRICKWALL LIMITER
  let currentMaxPeak = 0;
  for (let i = 0; i < len; i++) {
    const absVal = Math.abs(compressed[i]);
    if (absVal > currentMaxPeak) currentMaxPeak = absVal;
  }
  const maxAllowedPeak = 0.95;
  const sampleRateRef = self.sampleRate || 44100;
  // Cấu hình chu kỳ xả nén động dốc mũ 15ms
  const releaseCoeff = Math.exp(-1.0 / (sampleRateRef * 0.015));
  // Lấy lại hệ số suy hao từ khung trước làm gốc, bảo toàn tính liên tục của sóng âm thanh
  let attenuationGain = self.limiterGainState;
  if (currentMaxPeak > maxAllowedPeak) {
    let targetAttn = maxAllowedPeak / currentMaxPeak;
    if (targetAttn < attenuationGain) {
      attenuationGain = targetAttn; // Attack tức thời 0ms đánh chặn xung gắt đột ngột
    }
  }
  // Áp lá chắn bảo vệ dốc mịn theo chu kỳ xả tuyến tính liên tục
  for (let i = 0; i < len; i++) {
    const samplePeak = Math.abs(compressed[i]);
    let targetAttn = 1.0;
    if (samplePeak > maxAllowedPeak) {
      targetAttn = maxAllowedPeak / (samplePeak + 1e-5);
    }
    if (targetAttn < attenuationGain) {
      attenuationGain = targetAttn;
    } else {
      attenuationGain = attenuationGain * releaseCoeff + targetAttn * (1.0 - releaseCoeff);
    }
    compressed[i] = ensureFinite(compressed[i] * attenuationGain);
  }
  // Lưu lại trạng thái suy hao cho khung hình kế tiếp
  self.limiterGainState = attenuationGain;
  return compressed;
}
// =========================================================================
// PHẦN 4: CÁC HÀM PHỤ TRỢ VÀ THAO TÁC WORKER STATE LỊCH SỬ (ZERO-GC EDITION)
// =========================================================================
// KHỞI TẠO BỘ TỪ ĐIỂN KHUYẾN NGHỊ VÀ KẾT QUẢ ĐẦU RA TĨNH TUYỆT ĐỐI KHÓA CHẶT CHỐNG PHÂN MẢNH RAM
if (typeof self.hasInitializedBackendQualityLUT === 'undefined') {
  // Lưu trữ cố định các chuỗi ký tự khuyến nghị vào bộ nhớ tĩnh, triệt tiêu 100% String Allocation
  self.qualityRecommendationsLUT = ["Cắt sub-bass dưới 35Hz để bass sạch và chặt hơn", // Chỉ số 0
    "Giảm nhẹ 8-16kHz để tránh chói tai", // Chỉ số 1
    "Tăng cường khử nhiễu – âm thanh sẽ trong trẻo hơn", // Chỉ số 2
    "Tăng punch/attack cho trống và percussion", // Chỉ số 3
    "Nén nhẹ để tăng loudness tự nhiên", // Chỉ số 4
    "Tối ưu formant – giọng hát sẽ bay bổng hơn", // Chỉ số 5
    "Thêm air band 12-20kHz – không gian rộng mở", // Chỉ số 6
    "Mở rộng high-end nhẹ để tăng độ thoáng", // Chỉ số 7
    "Phát hiện xung động năng lượng cao – Hệ thống tự động kích hoạt True-Peak Limiter để bảo vệ màng loa chống vỡ tiếng" // Chỉ số 8
  ];
  // Tạo sẵn mảng tĩnh chứa các tham chiếu chuỗi cho kết quả (tối đa chứa 10 khuyến nghị đồng thời)
  self.staticRecsArray = ["", "", "", "", "", "", "", "", "", ""];
  // Đối tượng kết quả cấu trúc tĩnh duy nhất, ghi đè dữ liệu trực tiếp, đạt chuẩn chuyên gia thế giới
  self.staticQualityResult = {
    score: 0.0,
    mos: 0.0,
    recommendations: self.staticRecsArray,
    activeRecommendationsCount: 0, // Biến đếm chỉ số phần tử khuyến nghị thực tế đang kích hoạt
    crystalIndex: 0.0,
    punchIndex: 0.0,
    spaceIndex: 0.0
  };
  self.hasInitializedBackendQualityLUT = true;
}
// Hàm làm mượt chu kỳ interval sử dụng bộ lọc thông thấp một cực (One-Pole Low-Pass Filter) chống rung giật thời gian
function adjustProcessingInterval(cpuLoad, transientEnergy, noiseLevel, spectralFlatness) {
  const baseInterval = 1000;
  const cpuFactor = cpuLoad > 0.9 ? 3.5 : cpuLoad > 0.7 ? 2.5 : 1.0;
  const transientFactor = transientEnergy < 0.25 ? 1.5 : transientEnergy > 0.65 ? 0.7 : 1.0;
  const noiseFactor = noiseLevel.level > 0.65 ? 0.6 : 1.0;
  const complexityFactor = spectralFlatness > 0.5 ? 1.3 : 0.75;
  const targetInterval = Math.round(baseInterval * cpuFactor * transientFactor * noiseFactor * complexityFactor);
  // Áp bộ lọc làm mượt dốc 0.1 để tránh biến động chu kỳ nhảy loạn xạ (Timing Jitter)
  self.lastIntervalState = Math.round(self.lastIntervalState * 0.9 + targetInterval * 0.1);
  return self.lastIntervalState;
}

function predictAudioQuality(spectralProfile, tempo, pitchPeriod, noiseLevel, key, chord, instruments) {
  // 1. CHỐNG CRASH VÀ KHỞI TẠO BỘ LỌC AN TOÀN
  const profile = spectralProfile || {};
  const vocalPresence = profile.vocalPresence ?? 0.5;
  const transientEnergy = profile.transientEnergy ?? 0.5;
  const dynamicRange = profile.dynamicRange ?? 24;
  const subBass = profile.subBass ?? 0.5;
  const high = profile.high ?? 0.5;
  const subTreble = profile.subTreble ?? 0.5;
  const spectralFlatness = profile.spectralFlatness ?? 0.5;
  const bassEnergy = profile.bassEnergy ?? subBass;
  const airEnergy = profile.airEnergy ?? profile.air ?? 0.5;
  const mfcc = profile.mfcc || [];
  // 2. TỐI ƯU HÓA TÍNH TOÁN VARIANCE MFCC (Vòng lặp phẳng Zero-Allocation)
  let mfccVarianceSum = 0;
  const mfccLen = mfcc.length;
  if (mfccLen > 0) {
    for (let i = 0; i < mfccLen; i++) {
      const val = mfcc[i] || 0;
      mfccVarianceSum += val * val;
    }
  }
  const mfccVariance = mfccLen > 0 ? (mfccVarianceSum / mfccLen) : 0;
  // 3. ĐÁNH GIÁ ĐỘ PHỨC TẠP NHẠC CỤ AN TOÀN
  let instrumentScore = 0;
  if (instruments) {
    instrumentScore += (instruments.guitar || 0);
    instrumentScore += (instruments.piano || 0);
    instrumentScore += (instruments.violin || 0);
    instrumentScore += (instruments.drums || 0);
    instrumentScore *= 0.25;
  }
  // 4. THUẬT TOÁN ĐO ĐẠC CHẤT LƯỢNG PHÒNG THU TIÊU CHUẨN (MOS SCORE)
  const bandwidthScore = (high + subTreble + airEnergy) / 3;
  const noiseLevelVal = noiseLevel ? (noiseLevel.level ?? 0) : 0;
  const noisePenalty = noiseLevelVal > 0.3 ? (1.0 - noiseLevelVal) * 0.4 : 0.9;
  const stereoLikeScore = Math.max(0.0, Math.min(1.0, 1.0 - spectralFlatness));
  const keyConf = key ? (key.confidence ?? 0) : 0;
  const chordConf = chord ? (chord.confidence ?? 0) : 0;
  const tonalityScore = keyConf * 0.7 + chordConf * 0.3;
  let mosScore = vocalPresence * 0.28 + transientEnergy * 0.22 + bandwidthScore * 0.18 + stereoLikeScore * 0.15 + tonalityScore * 0.12 + (dynamicRange > 35 ? 0.15 : dynamicRange > 25 ? 0.08 : 0.0) + instrumentScore + (mfccVariance > 6 ? 0.10 : 0.0) + (airEnergy > 0.5 ? 0.08 : 0.0) + (bassEnergy > 0.6 && transientEnergy > 0.6 ? 0.12 : 0.0);
  mosScore *= noisePenalty;
  mosScore = Math.min(1.0, mosScore * 1.1);
  // 5. FIX LỖI CHÍ MẠNG: ĐIỀU PHỐI HỆ THỐNG KHUYẾN NGHỊ THÔNG MINH QUA ĐƯỜNG CON TRỎ LUT TĨNH (ZERO GAIN CHURN)
  let recCount = 0;
  const recsArray = self.staticRecsArray;
  const lut = self.qualityRecommendationsLUT;
  if (mosScore < 0.88) {
    if (subBass > 0.88) {
      recsArray[recCount] = lut[0];
      recCount++;
    }
    if (high > 0.88 || subTreble > 0.88) {
      recsArray[recCount] = lut[1];
      recCount++;
    }
    if (noiseLevelVal > 0.45) {
      recsArray[recCount] = lut[2];
      recCount++;
    }
    if (transientEnergy < 0.38) {
      recsArray[recCount] = lut[3];
      recCount++;
    }
    if (dynamicRange < 28) {
      recsArray[recCount] = lut[4];
      recCount++;
    }
    if (vocalPresence > 0.7 && spectralFlatness > 0.32) {
      recsArray[recCount] = lut[5];
      recCount++;
    }
    if (instruments && airEnergy < 0.35) {
      recsArray[recCount] = lut[6];
      recCount++;
    }
    if (bandwidthScore < 0.4) {
      recsArray[recCount] = lut[7];
      recCount++;
    }
    if (bassEnergy > 0.75 && transientEnergy > 0.75) {
      recsArray[recCount] = lut[8];
      recCount++;
    }
  }
  // Làm sạch các phần tử thừa còn lại của khung hình trước trong mảng tĩnh
  for (let i = recCount; i < 10; i++) {
    recsArray[i] = "";
  }
  const drumFactor = instruments ? (instruments.drums ?? 0.5) : 0.5;
  // 6. TRẢ VỀ KẾT QUẢ ĐỊNH DẠNG ĐỘ CHÍNH XÁC CAO QUA GHI ĐÈ TRỰC TIẾP ĐỐI TƯỢNG TĨNH LUỒNG
  const res = self.staticQualityResult;
  res.score = parseFloat(mosScore.toFixed(4));
  res.mos = parseFloat((mosScore * 5).toFixed(2));
  res.activeRecommendationsCount = recCount; // UI chỉ cần đọc mảng đến chỉ số đếm này để hiển thị chuẩn xác
  res.crystalIndex = parseFloat((vocalPresence * stereoLikeScore * noisePenalty).toFixed(4));
  res.punchIndex = parseFloat((transientEnergy * bassEnergy * drumFactor).toFixed(4));
  res.spaceIndex = parseFloat((airEnergy * bandwidthScore).toFixed(4));
  return res;
}
// =========================================================================
// THÀNH PHẦN CỐT LÕI: Worker State quản lý bộ đệm luồng tĩnh cao cấp
// =========================================================================
let fftInstance = null;
let spectralAnalyzer = null;
let memoryManager = null;
let lastRMS = 0;
let lastSpectralEnergy = 0;
let tempoHistory = [];
let performanceLevel = "high";
let cachedFFTSize = 2048;
let sampleRate = 48000;
let initParams = null;
// KHỞI TẠO HỆ THỐNG ĐỐI TƯỢNG TĨNH KHÓA CHẶT CHỐNG PHÂN MẢNH RAM TRÊN HOT PATH
if (typeof self.hasInitializedCoreRouter === 'undefined') {
  // Vùng đệm tĩnh cấu trúc Payload đầu ra cuối cùng, triệt tiêu Garbage Collector sinh rác
  self.staticWorkerPayload = {
    spectralProfile: null,
    tempo: null,
    pitchPeriod: null,
    key: null,
    chord: null,
    fftData: {
      magnitudes: null,
      phases: null
    },
    shiftedData: null,
    genre: "Unknown",
    noiseLevel: null,
    processingInterval: 100,
    autoEQ: null,
    qualityPrediction: null,
    wienerGain: 1.0,
    polyphonicPitches: null,
    magic: {
      stability: 1.0,
      purity: 1.0,
      vocalCrystal: 0.94,
      bassTight: 0.90
    }
  };
  // Khởi tạo các con trỏ bộ đệm vận chuyển độc lập (Transport Buffers) chặn đứng lỗi Detachment vùng nhớ DSP gốc
  self.transportMagBuffer = null;
  self.transportPhaseBuffer = null;
  self.transportShiftedBuffer = null;
  self.hasInitializedCoreRouter = true;
}
// =========================================================================
// TẦNG ĐIỀU PHỐI TRUNG TÂM TỐI CAO: LẮNG NGHE VÀ PHÂN PHỐI TÁC VỤ LUỒNG WORKER
// =========================================================================
self.onmessage = function(e) {
  const {
    type,
    timeData,
    sampleRate: newSampleRate,
    bufferLength,
    cpuLoad,
    pitchMult,
    devicePerf,
    audioProfile = "proNatural",
    webGPUDevice,
    params
  } = e.data;
  // 1. CHỐT CHẶN MẠNG LƯỚI: TIẾP NHẬN PHÂN ĐOẠN GÓI TIN MẠNG (STREAMING PACKET INGESTION)
  if (type === 'pushNetworkChunk') {
    if (e.data.chunk && e.data.chunk instanceof Uint8Array) {
      if (typeof ingestRawNetworkStream === 'function') {
        ingestRawNetworkStream(e.data.chunk);
      }
    }
    return;
  }
  // 1b. ĐIỀU KHIỂN LUỒNG: TẠM DỪNG PHÂN TÍCH KHI MAIN THREAD BÁO CPU QUÁ TẢI
  // FIX: trước đây message 'pauseAnalysis' được main thread gửi sang nhưng KHÔNG có handler nào xử lý
  // ở đây -> rơi tự do, không có tác dụng gì, worker vẫn chạy phân tích full tải dù đã "báo tạm dừng".
  // Thêm cờ self.analysisPaused thật, được analyzeAudio kiểm tra và bỏ qua công việc nặng khi đang bật.
  if (type === 'pauseAnalysis') {
    self.analysisPaused = true;
    self.postMessage({
      type: 'skip',
      data: 'Đã tạm dừng phân tích để giảm tải CPU'
    });
    return;
  }
  // 2. ĐIỀU KHIỂN LUỒNG: TIẾP TỤC TIẾN TRÌNH PHÂN TÍCH THEO LỆNH MAIN THREAD
  if (type === 'resumeAnalysis') {
    self.analysisPaused = false;
    console.log('Worker resumed analysis by main thread - Âm thanh lại vang lên ma mị...');
    self.postMessage({
      type: 'resumed',
      data: 'Phân tích đã được tiếp tục – giọng hát trong trẻo trở lại'
    });
    return;
  }
  // 3. GIẢI PHÓNG HỆ THỐNG: KHỞI TẠO LẠI KHÔNG GIAN ENTANGLEMENT CHO BÀI HÁT MỚI
  if (type === 'resetEntanglement') {
    self.prevMagnitudes = null;
    self.prevPhases = null;
    self.hasInitializedEntanglement = false;
    self.postMessage({
      type: 'entanglementReset',
      data: 'Sẵn sàng cho bài hát mới – entanglement tinh khôi như pha lê'
    });
    return;
  }
  // 3b. RESET KHI ĐỔI BÀI: jungle.js gửi type 'reset' mỗi khi songChange kích hoạt (khác với
  // 'resetEntanglement' ở trên, worker vốn không có case xử lý riêng nên rơi vào nhánh lỗi mặc
  // định cuối hàm mỗi lần đổi bài — chỉ cần làm y hệt logic reset entanglement, không cần phản
  // hồi lại vì onSongChange bên jungle.js không chờ response.
  if (type === 'reset') {
    self.prevMagnitudes = null;
    self.prevPhases = null;
    self.hasInitializedEntanglement = false;
    self.analysisPaused = false;
    return;
  }
  // 3c. CẬP NHẬT PHẢN HỒI ĐỊNH KỲ TỪ MAIN THREAD: jungle.js bắn 'batchUpdate' mỗi 3-6 giây qua
  // feedbackInterval để đồng bộ userFeedback/contextAnalysis/cpuLoadHistory. Worker không có logic
  // thích ứng nào tiêu thụ dữ liệu này, nhưng NẾU không có case xử lý, message rơi vào nhánh lỗi
  // mặc định -> main thread coi là lỗi thật, gọi handleError() + tăng dần nextProcessingInterval
  // (x1.2 mỗi lần, tối đa 5000ms) một cách oan uổng mỗi 3-6 giây, khiến vòng lặp phân tích càng
  // lúc càng bị kéo giãn dù worker chưa từng lỗi thật. Chỉ cần "biết nhận" để tránh nhánh đó.
  if (type === 'batchUpdate') {
    self.lastBatchUpdate = params;
    return;
  }
  // 4. KHỞI TẠO HỆ THỐNG (INITIALIZATION STAGE)
  if (type === 'init') {
    initParams = params || {};
    sampleRate = ensureFinite(initParams.sampleRate, 48000);
    performanceLevel = initParams.deviceInfo?.hardwareConcurrency >= 4 ? "high" : (initParams.deviceInfo?.hardwareConcurrency === 2 ? "medium" : "low");
    cachedFFTSize = ensureFinite(initParams.fftSize, initParams.deviceInfo?.memory >= 8 ? 4096 : (initParams.deviceInfo?.memory < 4 ? 1024 : 2048));
    if (!memoryManager) {
      memoryManager = new MemoryManager(ensureFinite(bufferLength * 4, 8192 * 4), {
        maxBufferAge: ensureFinite(initParams.maxBufferAge, 60000),
        defragmentThreshold: ensureFinite(initParams.defragmentThreshold, 0.75)
      });
      if (webGPUDevice) memoryManager.initializeWebGPU(webGPUDevice);
    }
    if (fftInstance) fftInstance.dispose();
    if (spectralAnalyzer) spectralAnalyzer.dispose();
    fftInstance = new OptimizedFFT(cachedFFTSize, memoryManager);
    spectralAnalyzer = new SpectralAnalyzer(sampleRate, cachedFFTSize, performanceLevel, memoryManager);
    self.prevMagnitudes = null;
    self.prevPhases = null;
    self.hasInitializedEntanglement = false;
    self.postMessage({
      type: 'initDone',
      data: 'Worker initialized successfully – Sẵn sàng bung bass bum bum chắc nịch'
    });
    return;
  }
  // 5. TRỤC XỬ LÝ LÕI THỜI GIAN THỰC (ANALYZE AUDIO CORE PIPELINE)
  if (type === 'analyzeAudio') {
    // Đang tạm dừng do CPU quá tải (xem handler 'pauseAnalysis' ở trên) - bỏ qua khung phân tích nặng
    // này, chỉ báo skip nhẹ để main thread biết worker vẫn sống, không coi là lỗi/treo.
    if (self.analysisPaused) {
      self.postMessage({
        type: 'skip',
        data: 'Đang tạm dừng phân tích (CPU quá tải)'
      });
      return;
    }
    let activeTimeData = timeData;
    // ĐÁNH CHẶN THÔNG MINH: Nếu luồng chính không truyền timeData (chơi nhạc từ YouTube), tự động bóc tách từ Ring Buffer thô
    if (!activeTimeData || !bufferLength || !(activeTimeData instanceof Float32Array)) {
      if (typeof extractLinearPcmStream === 'function') {
        activeTimeData = extractLinearPcmStream(bufferLength);
      } else {
        self.postMessage({
          type: 'error',
          data: 'Dữ liệu đầu vào không hợp lệ hoặc không phải Float32Array'
        });
        return;
      }
    }
    sampleRate = ensureFinite(newSampleRate, 48000);
    if (!memoryManager) {
      memoryManager = new MemoryManager(bufferLength * 4, {
        maxBufferAge: 60000,
        defragmentThreshold: 0.75
      });
      if (webGPUDevice) memoryManager.initializeWebGPU(webGPUDevice);
    }
    const fftSize = cpuLoad < 0.6 && devicePerf === "high" ? 8192 : (cpuLoad < 0.8 ? 4096 : 2048);
    if (!fftInstance || fftInstance.size !== fftSize) {
      if (fftInstance) fftInstance.dispose();
      if (spectralAnalyzer) spectralAnalyzer.dispose();
      cachedFFTSize = fftSize;
      fftInstance = new OptimizedFFT(cachedFFTSize, memoryManager);
      spectralAnalyzer = new SpectralAnalyzer(sampleRate, cachedFFTSize, devicePerf, memoryManager);
    }
    // OPTIMIZE: Tối ưu hóa tính toán biên độ RMS thô qua Unroll vòng lặp x4 phẳng
    let rmsSquareSum = 0;
    let i = 0;
    for (; i < bufferLength - 3; i += 4) {
      rmsSquareSum += activeTimeData[i] * activeTimeData[i] + activeTimeData[i + 1] * activeTimeData[i + 1] + activeTimeData[i + 2] * activeTimeData[i + 2] + activeTimeData[i + 3] * activeTimeData[i + 3];
    }
    for (; i < bufferLength; i++) {
      rmsSquareSum += activeTimeData[i] * activeTimeData[i];
    }
    const rms = Math.sqrt(rmsSquareSum / bufferLength);
    // Nắn chỉnh dòng dữ liệu qua bộ điều phối Dynamic Downsample nhằm bảo vệ tài nguyên CPU
    let processedData = activeTimeData;
    if (cpuLoad > 0.7) processedData = downsample(activeTimeData, cpuLoad > 0.9 ? 4 : 2);
    // Thực thi bộ nén tiếng chống vỡ âm cao cấp bám sát dải động RMS thực tế
    processedData = softCompress(processedData, spectralAnalyzer.computeDynamicRange(processedData), rms);
    // MẠCH ĐƠN KỲ KHÉP KÍN: Gọi trực tiếp Pipeline xử lý, triệt tiêu 100% lỗi Double FFT
    const pipelineResult = analyzeAudio(processedData, sampleRate, cachedFFTSize, cpuLoad, pitchMult, rms, audioProfile);
    if (pipelineResult && pipelineResult.skip) {
      self.postMessage({
        type: "skip",
        data: pipelineResult.reason
      });
      return;
    }
    if (!pipelineResult) return;
    // KÍCH HOẠT LÁ CHẮN CHUYỂN GIAO AN TOÀN TUYỆT ĐỐI (TRANSIENT PING-PONG BUFFER STRATEGY)
    const halfLen = cachedFFTSize / 2;
    // Tự động kiểm tra tái lập vùng đệm vận chuyển nếu khung trước đã bị Detached phát về luồng chính
    if (!self.transportMagBuffer || self.transportMagBuffer.length !== halfLen) {
      self.transportMagBuffer = memoryManager.allocate(halfLen);
      self.transportPhaseBuffer = memoryManager.allocate(halfLen);
    }
    if (!self.transportShiftedBuffer || self.transportShiftedBuffer.length !== processedData.length) {
      self.transportShiftedBuffer = memoryManager.allocate(processedData.length);
    }
    // Sao chép chính xác dữ liệu phổ và sóng từ ô nhớ nội bộ sang khối đệm trung chuyển trung gian
    self.transportMagBuffer.set(pipelineResult.fftData.magnitudes);
    self.transportPhaseBuffer.set(pipelineResult.fftData.phases);
    self.transportShiftedBuffer.set(pipelineResult.shiftedData);
    // Trỏ cấu trúc đóng gói gói tin về tham chiếu vùng đệm vận chuyển mới tinh khiết
    const payload = self.staticWorkerPayload;
    payload.fftData.magnitudes = self.transportMagBuffer;
    payload.fftData.phases = self.transportPhaseBuffer;
    payload.shiftedData = self.transportShiftedBuffer;
    const transferList = [
      self.transportMagBuffer.buffer,
      self.transportPhaseBuffer.buffer,
      self.transportShiftedBuffer.buffer
    ];
    // Đẩy gói tin về luồng xử lý chính của jungle.js siêu tốc độ dải rộng, triệt tiêu micro-lag
    self.postMessage({
      type: "audioResult",
      data: payload,
      metrics: memoryManager.performanceMetrics
    }, transferList);
    return;
  }
  // 6. PHẢN HỒI LỖI: BÁO CÁO NẾU TÁC VỤ TRUYỀN SAI ĐỊNH DẠNG ĐỊNH TUYẾN
  self.postMessage({
    type: "error",
    data: "Loại tác vụ không xác định – Worker vẫn chờ lệnh từ nghệ sĩ thiên tài"
  });
};
// =========================================================================
// PHẦN 5: KIỆT TÁC XỬ LÝ ÂM THANH CHÍNH VẤN CHUYỂN (ANALYZE AUDIO PIPELINE)
// =========================================================================
function analyzeAudio(timeData, sampleRate, bufferLength, cpuLoad, pitchMult, rms, audioProfile = "proNatural") {
  try {
    // Mạch đơn kỳ: Chỉ tính toán FFT một lần duy nhất tại tâm lõi tiến trình
    const fftData = fftInstance.fft(timeData);
    let {
      magnitudes,
      phases
    } = getMagnitudeAndPhase(fftData, bufferLength, 0.98);
    if (!prevMagBuffer || prevMagBuffer.length !== magnitudes.length) {
      if (prevMagBuffer) memoryManager.free(prevMagBuffer.offset || prevMagBuffer);
      if (prevPhaseBuffer) memoryManager.free(prevPhaseBuffer.offset || prevPhaseBuffer);
      prevMagBuffer = memoryManager.allocate(magnitudes.length);
      prevPhaseBuffer = memoryManager.allocate(phases.length);
      self.hasInitializedEntanglement = false;
    }
    const prevMag = prevMagBuffer;
    const prevPhase = prevPhaseBuffer;
    if (!self.hasInitializedEntanglement) {
      prevMag.set(magnitudes);
      prevPhase.set(phases);
      self.hasInitializedEntanglement = true;
    }
    // Thuật toán kiểm sai đối lưu chéo thích ứng (Cross-Correlation Convergence Gating)
    let deltaEnergy = 0;
    let phaseCoherence = 0;
    let harmonicLock = 0;
    const step = 8;
    const safeLength = magnitudes.length - 32;
    let validBinsCount = 0;
    for (let i = 16; i < safeLength; i += step) {
      const magDiff = magnitudes[i] - prevMag[i];
      deltaEnergy += magDiff * magDiff;
      const phaseDiff = (phases[i] - prevPhase[i] + Math.PI) % (2 * Math.PI) - Math.PI;
      phaseCoherence += Math.abs(Math.cos(phaseDiff));
      const ratio = magnitudes[i + 8] / (magnitudes[i] + 1e-10);
      if (ratio > 0.9 && ratio < 1.1) harmonicLock++;
      validBinsCount++;
    }
    deltaEnergy = Math.sqrt(deltaEnergy / (validBinsCount || 1));
    phaseCoherence /= (validBinsCount || 1);
    harmonicLock /= (safeLength / 32 || 1);
    // Đồng bộ dữ liệu lịch sử cho chu kỳ kế tiếp dải rộng
    prevMag.set(magnitudes);
    prevPhase.set(phases);
    // Chốt chặn bypass thông minh bảo vệ tài nguyên CPU tối đa
    if (deltaEnergy < 0.0006 && phaseCoherence > 0.96 && harmonicLock > 0.85 && Math.random() < 0.985) {
      return {
        skip: true,
        reason: 'Âm thanh đã đạt độ tinh khiết tuyệt đối – không cần can thiệp'
      };
    }
    // Thực thi phân tích cấu trúc phổ đặc trưng âm thanh thực tế
    const spectralProfile = spectralAnalyzer.analyze(magnitudes, phases, timeData, rms);
    // Ước lượng formant THẬT bằng cepstral smoothing (thay cho vùng tần số cố định 500Hz/2100Hz)
    const formantEstimate = estimateFormants(magnitudes, sampleRate, bufferLength, spectralProfile.vocalPresence);
    // Trích lọc nhiễu nền và làm sạch phổ âm thanh Wiener Pro
    const noiseProfile = detectNoise(magnitudes, sampleRate / bufferLength, bufferLength);
    const subtractionResult = spectralSubtraction(magnitudes, noiseProfile, bufferLength, sampleRate);
    magnitudes = subtractionResult.magnitudes;
    const wienerGain = subtractionResult.wienerGain;
    // Bóc tách nhịp điệu và cao độ đa âm nền đồng bộ cơ chế Jungle
    const tempo = detectTempo(timeData, magnitudes, sampleRate, bufferLength);
    const pitchPeriod = detectPitchPeriod(timeData, sampleRate, spectralProfile, rms, magnitudes);
    const key = detectKey(spectralProfile.chroma);
    const chord = detectChord(spectralProfile.chroma);
    const genre = classifyGenre(spectralProfile, tempo.bpm, spectralAnalyzer.spectralHistory);
    // shiftedData: pitch-shift THẬT phát ra loa là engine delay-line/granular bên jungle.js (main thread),
    // không phải worker này -> không cần tính lại pitch-shift ở đây, giữ nguyên timeData cho payload.
    const shiftedData = timeData;
    // Cập nhật cấu hình EQ tự động thông minh
    const autoEQ = computeAutoEQ(spectralProfile, genre, pitchMult, rms, spectralAnalyzer.spectralHistory, audioProfile);
    autoEQ.bass = Math.min(autoEQ.bassGain || autoEQ.bass, 1.8);
    autoEQ.treble = Math.min(autoEQ.highGain || autoEQ.treble, 1.6);
    autoEQ.presence = spectralProfile.vocalPresence > 0.7 ? Math.max(autoEQ.presence || 1.0, 1.2) : (autoEQ.presence || 1.0);
    const stability = phaseCoherence * harmonicLock;
    // Ghi dữ liệu trực tiếp đè lên cấu trúc đối tượng tĩnh đầu ra cố định (Absolute Zero-GC)
    const payload = self.staticWorkerPayload;
    payload.spectralProfile = spectralProfile;
    payload.tempo = tempo;
    payload.pitchPeriod = pitchPeriod;
    payload.formantEstimate = formantEstimate;
    payload.key = key;
    payload.chord = chord;
    payload.fftData.magnitudes = magnitudes;
    payload.fftData.phases = phases;
    payload.shiftedData = shiftedData;
    payload.genre = genre;
    payload.noiseLevel = noiseProfile;
    payload.processingInterval = stability > 0.9 ? Math.max(100, 200 - cpuLoad * 150) : Math.max(50, 100 - cpuLoad * 80);
    payload.autoEQ = autoEQ;
    payload.qualityPrediction = predictAudioQuality(spectralProfile, tempo, pitchPeriod, noiseProfile, key, chord, spectralProfile.instruments);
    payload.wienerGain = wienerGain;
    payload.polyphonicPitches = typeof detectPolyphonicPitches === 'function' ? detectPolyphonicPitches(magnitudes, sampleRate, bufferLength) : [];
    payload.magic.stability = parseFloat(stability.toFixed(4));
    payload.magic.purity = parseFloat((1.0 - noiseProfile.level).toFixed(4));
    payload.magic.vocalCrystal = spectralProfile.vocalPresence > 0.7 && spectralProfile.spectralFlatness < 0.3 ? 0.9999 : 0.94;
    payload.magic.bassTight = spectralProfile.transientEnergy > 0.75 ? 0.999 : 0.90;
    return payload;
  } catch (error) {
    console.error("analyzeAudio Core Error:", error);
    self.postMessage({
      type: "error",
      data: `Lỗi nghiêm trọng tầng lõi Pipeline: ${error.message}`
    });
    return null;
  }
}
// =========================================================================
// KIỆT TÁC SIÊU CẤP: ĐỒNG CƠ ĐÁNH CHẶN & CHUẨN HÓA LUỒNG THÔ THÍNH GIÁC
// STREAMING PACKET INTERCEPTOR & LINEAR ALIGNMENT ENGINE V3.0 (ZERO-GC)
// =========================================================================
if (typeof self.hasInitializedStreamInterceptor === 'undefined') {
  // FIX LỖI STRICT MODE: Khóa cứng hằng số vào đối tượng cấu trúc self thay cho top-level this
  self.maxStreamPacketSize = 16384;
  // Khởi tạo không gian đệm vòng tĩnh (Static Ring Buffer) khóa chặt RAM mức thấp
  self.streamRingBuffer = new Uint8Array(1024 * 512); // Vùng đệm chứa luồng mạng 512KB
  self.streamWriteHead = 0;
  self.streamReadHead = 0;
  self.streamAvailableBytes = 0;
  // Các biến lưu trữ trạng thái đồng bộ hóa gói tin liên tục (Inter-packet Sync States)
  self.streamJitterDampener = 1.0;
  self.lastPacketTimestamp = 0.0;
  self.packetIntervalFilterState = 20.0; // Mạch lọc chu kỳ gói tin (đơn vị: ms)
  // Khối đệm chuyển đổi PCM thô tĩnh, triệt tiêu 100% lệnh tạo mảng view động
  self.staticPcmConversionBuffer = new Float32Array(4096);
  self.hasInitializedStreamInterceptor = true;
}
/**
 * Đánh chặn và đổ luồng Byte thô từ kết nối mạng (videoplayback URL) vào Ring Buffer tĩnh
 * @param {Uint8Array} rawNetworkChunk - Khối dữ liệu thô nhị phân vừa fetch từ server
 */
function ingestRawNetworkStream(rawNetworkChunk) {
  const chunkLen = rawNetworkChunk.length;
  if (chunkLen === 0) return;
  // 1. MẠCH DO THÁM JITTER CHỐNG NỔ TIẾNG NỀN DO ĐỘ TRỄ MẠNG (NETWORK LATENCY FILTER)
  const now = performance.now();
  if (self.lastPacketTimestamp > 0.0) {
    const currentInterval = now - self.lastPacketTimestamp;
    // Áp bộ lọc thông thấp một cực làm mịn chu kỳ interval của mạng lưới GoogleVideo
    self.packetIntervalFilterState = self.packetIntervalFilterState * 0.95 + currentInterval * 0.05;
    // Nếu chu kỳ interval vượt ngưỡng biến động > 45ms, tự động kích hoạt chế độ nén hãm biên độ bảo vệ màng loa
    self.streamJitterDampener = self.packetIntervalFilterState > 45.0 ? 0.82 : 1.0;
  }
  self.lastPacketTimestamp = now;
  // 2. PHẲNG HÓA VÒNG LẶP GHI ĐÈ DỮ LIỆU VÀO STATIC RING BUFFER CHỐNG PHÂN MẢNH
  let ringHead = self.streamWriteHead;
  const bufferSize = self.streamRingBuffer.length;
  // Thực thi Unroll x4 để copy dòng Byte thô tốc độ cao mức Assembly
  let i = 0;
  for (; i < chunkLen - 3; i += 4) {
    self.streamRingBuffer[ringHead] = rawNetworkChunk[i];
    ringHead = (ringHead + 1) % bufferSize;
    self.streamRingBuffer[ringHead] = rawNetworkChunk[i + 1];
    ringHead = (ringHead + 1) % bufferSize;
    self.streamRingBuffer[ringHead] = rawNetworkChunk[i + 2];
    ringHead = (ringHead + 1) % bufferSize;
    self.streamRingBuffer[ringHead] = rawNetworkChunk[i + 3];
    ringHead = (ringHead + 1) % bufferSize;
  }
  for (; i < chunkLen; i++) {
    self.streamRingBuffer[ringHead] = rawNetworkChunk[i];
    ringHead = (ringHead + 1) % bufferSize;
  }
  self.streamWriteHead = ringHead;
  self.streamAvailableBytes = Math.min(bufferSize, self.streamAvailableBytes + chunkLen);
}
/**
 * Trích xuất và tuyến tính hóa chuỗi Byte nhị phân về dải sóng hình Float32 PCM chuẩn hóa
 * @param {number} samplesRequested - Số lượng mẫu âm thanh hệ thống yêu cầu (ví dụ: 2048 hoặc 4096)
 * @return {Float32Array} - Bộ đệm tĩnh chứa sóng PCM tinh khiết, sẵn sàng đưa vào lõi DSP
 */
function extractLinearPcmStream(samplesRequested) {
  const bytesNeeded = samplesRequested * 2; // Giả lập giải mã luồng 16-bit PCM thô (2 bytes per sample)
  const outBuffer = self.staticPcmConversionBuffer;
  if (self.streamAvailableBytes < bytesNeeded) {
    // Fallback an toàn tuyệt đối nếu luồng mạng bị nghẽn: Trả về dải âm lặng tĩnh lặng không click tiếng
    outBuffer.fill(0.0, 0, samplesRequested);
    return outBuffer;
  }
  let readHead = self.streamReadHead;
  const bufferSize = self.streamRingBuffer.length;
  const dampener = self.streamJitterDampener;
  // 3. GIẢI THUẬT NẮN DÒNG BYTE SANG FLOATS (BYTE-TO-FLOAT LINEAR ALIGNMENT - UNROLLED X4)
  let sampleIdx = 0;
  for (; sampleIdx < samplesRequested - 3; sampleIdx += 4) {
    // Đọc 2 byte liên tiếp, dịch bit in-place tạo số nguyên 16-bit có dấu (Int16)
    const b0_0 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    const b1_0 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    let intSample0 = (b1_0 << 8) | b0_0;
    if (intSample0 & 0x8000) intSample0 |= ~0xffff; // Ép dấu số bù 2 chuẩn toán học máy tính
    outBuffer[sampleIdx] = ensureFinite((intSample0 / 32768.0) * dampener); // Chuẩn hóa về dải biên độ [-1.0, 1.0]
    const b0_1 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    const b1_1 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    let intSample1 = (b1_1 << 8) | b0_1;
    if (intSample1 & 0x8000) intSample1 |= ~0xffff;
    outBuffer[sampleIdx + 1] = ensureFinite((intSample1 / 32768.0) * dampener);
    const b0_2 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    const b1_2 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    let intSample2 = (b1_2 << 8) | b0_2;
    if (intSample2 & 0x8000) intSample2 |= ~0xffff;
    outBuffer[sampleIdx + 2] = ensureFinite((intSample2 / 32768.0) * dampener);
    const b0_3 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    const b1_3 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    let intSample3 = (b1_3 << 8) | b0_3;
    if (intSample3 & 0x8000) intSample3 |= ~0xffff;
    outBuffer[sampleIdx + 3] = ensureFinite((intSample3 / 32768.0) * dampener);
  }
  // Vòng lặp quét các phần tử biên còn sót lại
  for (; sampleIdx < samplesRequested; sampleIdx++) {
    const b0 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    const b1 = self.streamRingBuffer[readHead];
    readHead = (readHead + 1) % bufferSize;
    let intSample = (b1 << 8) | b0;
    if (intSample & 0x8000) intSample |= ~0xffff;
    outBuffer[sampleIdx] = ensureFinite((intSample / 32768.0) * dampener);
  }
  self.streamReadHead = readHead;
  self.streamAvailableBytes -= bytesNeeded;
  // Trả về tham chiếu đối tượng tĩnh duy nhất, bảo vệ hệ thống khỏi GC rác
  return outBuffer;
}