/*
 * Zero-dependency QR Code generator.
 *
 * Ported to TypeScript from Nayuki's "QR Code generator library" (MIT License):
 *   https://www.nayuki.io/page/qr-code-generator-library
 *   Copyright (c) Project Nayuki.
 *
 * Trimmed to byte-mode encoding (sufficient for URL strings) plus a terminal
 * half-block renderer that mirrors `qrcode`'s `type:'utf8'` output, so the
 * WeChat login QR needs no external npm package.
 */
const ECC_M_FORMAT_BITS = 0; // Medium error-correction level
const ECC_M_ORDINAL = 1;
// Indexed [eccOrdinal][version]; version 0 is unused padding (-1).
const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Low
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // Medium
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Quartile
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // High
];
const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // Low
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // Medium
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Quartile
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // High
];
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;
const MIN_VERSION = 1;
const MAX_VERSION = 40;
function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
}
function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7)
            result -= 36;
    }
    return result;
}
function getNumDataCodewords(ver, eccOrdinal) {
    return (Math.floor(getNumRawDataModules(ver) / 8) -
        ECC_CODEWORDS_PER_BLOCK[eccOrdinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[eccOrdinal][ver]);
}
function numCharCountBits(ver) {
    // Byte mode
    return ver <= 9 ? 8 : 16;
}
// --- Reed-Solomon ----------------------------------------------------------
function reedSolomonMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}
function reedSolomonComputeDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = reedSolomonMultiply(result[j], root);
            if (j + 1 < result.length)
                result[j] ^= result[j + 1];
        }
        root = reedSolomonMultiply(root, 0x02);
    }
    return result;
}
function reedSolomonComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => {
            result[i] ^= reedSolomonMultiply(coef, factor);
        });
    }
    return result;
}
// --- QR matrix construction ------------------------------------------------
class QrCode {
    version;
    eccOrdinal;
    size;
    modules;
    isFunction;
    constructor(version, eccOrdinal, dataCodewords, mask) {
        this.version = version;
        this.eccOrdinal = eccOrdinal;
        this.size = version * 4 + 17;
        const size = this.size;
        this.modules = Array.from({ length: size }, () => new Array(size).fill(false));
        this.isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
        this.drawFunctionPatterns();
        const allCodewords = this.addEccAndInterleave(dataCodewords);
        this.drawCodewords(allCodewords);
        if (mask === -1) {
            let minPenalty = Infinity;
            for (let i = 0; i < 8; i++) {
                this.applyMask(i);
                this.drawFormatBits(i);
                const penalty = this.getPenaltyScore();
                if (penalty < minPenalty) {
                    mask = i;
                    minPenalty = penalty;
                }
                this.applyMask(i); // undo
            }
        }
        this.applyMask(mask);
        this.drawFormatBits(mask);
    }
    getModule(x, y) {
        return this.modules[y][x];
    }
    setFunctionModule(x, y, isDark) {
        this.modules[y][x] = isDark;
        this.isFunction[y][x] = true;
    }
    drawFunctionPatterns() {
        const size = this.size;
        for (let i = 0; i < size; i++) {
            this.setFunctionModule(6, i, i % 2 === 0);
            this.setFunctionModule(i, 6, i % 2 === 0);
        }
        this.drawFinderPattern(3, 3);
        this.drawFinderPattern(size - 4, 3);
        this.drawFinderPattern(3, size - 4);
        const alignPatPos = this.getAlignmentPatternPositions();
        const numAlign = alignPatPos.length;
        for (let i = 0; i < numAlign; i++) {
            for (let j = 0; j < numAlign; j++) {
                if ((i === 0 && j === 0) ||
                    (i === 0 && j === numAlign - 1) ||
                    (i === numAlign - 1 && j === 0))
                    continue;
                this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
            }
        }
        this.drawFormatBits(0);
        this.drawVersion();
    }
    drawFinderPattern(x, y) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
                    this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
                }
            }
        }
    }
    drawAlignmentPattern(x, y) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }
    getAlignmentPatternPositions() {
        if (this.version === 1)
            return [];
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
        const result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
            result.splice(1, 0, pos);
        }
        return result;
    }
    drawFormatBits(mask) {
        const size = this.size;
        const data = (ECC_M_FORMAT_BITS << 3) | mask; // 5 bits
        let rem = data;
        for (let i = 0; i < 10; i++)
            rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412; // 15 bits
        for (let i = 0; i <= 5; i++)
            this.setFunctionModule(8, i, getBit(bits, i));
        this.setFunctionModule(8, 7, getBit(bits, 6));
        this.setFunctionModule(8, 8, getBit(bits, 7));
        this.setFunctionModule(7, 8, getBit(bits, 8));
        for (let i = 9; i < 15; i++)
            this.setFunctionModule(14 - i, 8, getBit(bits, i));
        for (let i = 0; i < 8; i++)
            this.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
        for (let i = 8; i < 15; i++)
            this.setFunctionModule(8, size - 15 + i, getBit(bits, i));
        this.setFunctionModule(8, size - 8, true);
    }
    drawVersion() {
        if (this.version < 7)
            return;
        let rem = this.version;
        for (let i = 0; i < 12; i++)
            rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (this.version << 12) | rem; // 18 bits
        for (let i = 0; i < 18; i++) {
            const color = getBit(bits, i);
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunctionModule(a, b, color);
            this.setFunctionModule(b, a, color);
        }
    }
    addEccAndInterleave(data) {
        const ver = this.version;
        const ecc = this.eccOrdinal;
        const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][ver];
        const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][ver];
        const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
        const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
        const shortBlockLen = Math.floor(rawCodewords / numBlocks);
        const blocks = [];
        const rsDiv = reedSolomonComputeDivisor(blockEccLen);
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
            const dat = data.slice(k, k + datLen);
            k += dat.length;
            const eccBytes = reedSolomonComputeRemainder(dat, rsDiv);
            if (i < numShortBlocks)
                dat.push(0);
            blocks.push(dat.concat(eccBytes));
        }
        const result = [];
        for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((block, j) => {
                if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
                    result.push(block[i]);
                }
            });
        }
        return result;
    }
    drawCodewords(data) {
        const size = this.size;
        let i = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6)
                right = 5;
            for (let vert = 0; vert < size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (!this.isFunction[y][x] && i < data.length * 8) {
                        this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                        i++;
                    }
                }
            }
        }
    }
    applyMask(mask) {
        const size = this.size;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (this.isFunction[y][x])
                    continue;
                let invert;
                switch (mask) {
                    case 0:
                        invert = (x + y) % 2 === 0;
                        break;
                    case 1:
                        invert = y % 2 === 0;
                        break;
                    case 2:
                        invert = x % 3 === 0;
                        break;
                    case 3:
                        invert = (x + y) % 3 === 0;
                        break;
                    case 4:
                        invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
                        break;
                    case 5:
                        invert = ((x * y) % 2) + ((x * y) % 3) === 0;
                        break;
                    case 6:
                        invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
                        break;
                    case 7:
                        invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
                        break;
                    default: throw new Error('Invalid mask');
                }
                if (invert)
                    this.modules[y][x] = !this.modules[y][x];
            }
        }
    }
    getPenaltyScore() {
        const size = this.size;
        let result = 0;
        for (let y = 0; y < size; y++) {
            let runColor = false;
            let runX = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let x = 0; x < size; x++) {
                if (this.modules[y][x] === runColor) {
                    runX++;
                    if (runX === 5)
                        result += PENALTY_N1;
                    else if (runX > 5)
                        result++;
                }
                else {
                    this.finderPenaltyAddHistory(runX, runHistory);
                    if (!runColor)
                        result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
                    runColor = this.modules[y][x];
                    runX = 1;
                }
            }
            result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
        }
        for (let x = 0; x < size; x++) {
            let runColor = false;
            let runY = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let y = 0; y < size; y++) {
                if (this.modules[y][x] === runColor) {
                    runY++;
                    if (runY === 5)
                        result += PENALTY_N1;
                    else if (runY > 5)
                        result++;
                }
                else {
                    this.finderPenaltyAddHistory(runY, runHistory);
                    if (!runColor)
                        result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
                    runColor = this.modules[y][x];
                    runY = 1;
                }
            }
            result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
        }
        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const color = this.modules[y][x];
                if (color === this.modules[y][x + 1] &&
                    color === this.modules[y + 1][x] &&
                    color === this.modules[y + 1][x + 1]) {
                    result += PENALTY_N2;
                }
            }
        }
        let dark = 0;
        for (const row of this.modules)
            for (const c of row)
                if (c)
                    dark++;
        const total = size * size;
        const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        result += k * PENALTY_N4;
        return result;
    }
    finderPenaltyCountPatterns(runHistory) {
        const n = runHistory[1];
        const core = n > 0 &&
            runHistory[2] === n &&
            runHistory[3] === n * 3 &&
            runHistory[4] === n &&
            runHistory[5] === n;
        return ((core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
            (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0));
    }
    finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
        if (currentRunColor) {
            this.finderPenaltyAddHistory(currentRunLength, runHistory);
            currentRunLength = 0;
        }
        currentRunLength += this.size;
        this.finderPenaltyAddHistory(currentRunLength, runHistory);
        return this.finderPenaltyCountPatterns(runHistory);
    }
    finderPenaltyAddHistory(currentRunLength, runHistory) {
        if (runHistory[0] === 0)
            currentRunLength += this.size;
        runHistory.pop();
        runHistory.unshift(currentRunLength);
    }
}
function encodeBytesToCodewords(data, version, eccOrdinal) {
    const bits = [];
    const appendBits = (val, len) => {
        for (let i = len - 1; i >= 0; i--)
            bits.push((val >>> i) & 1);
    };
    appendBits(0x4, 4); // byte mode indicator
    appendBits(data.length, numCharCountBits(version));
    for (const b of data)
        appendBits(b, 8);
    const dataCapacityBits = getNumDataCodewords(version, eccOrdinal) * 8;
    appendBits(0, Math.min(4, dataCapacityBits - bits.length)); // terminator
    appendBits(0, (8 - (bits.length % 8)) % 8); // pad to byte boundary
    for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11)
        appendBits(pad, 8);
    const codewords = new Array(bits.length / 8).fill(0);
    bits.forEach((bit, i) => {
        codewords[i >>> 3] |= bit << (7 - (i & 7));
    });
    return codewords;
}
/** Encode `text` into a QR module matrix. `true` = dark module. */
export function encodeQrMatrix(text) {
    const data = Array.from(new TextEncoder().encode(text));
    const eccOrdinal = ECC_M_ORDINAL;
    let version = MIN_VERSION;
    for (;; version++) {
        if (version > MAX_VERSION) {
            throw new Error('Data too long to fit in any QR Code version');
        }
        const dataCapacityBits = getNumDataCodewords(version, eccOrdinal) * 8;
        const usedBits = 4 + numCharCountBits(version) + data.length * 8;
        if (usedBits <= dataCapacityBits)
            break;
    }
    const codewords = encodeBytesToCodewords(data, version, eccOrdinal);
    const qr = new QrCode(version, eccOrdinal, codewords, -1);
    const matrix = [];
    for (let y = 0; y < qr.size; y++) {
        const row = [];
        for (let x = 0; x < qr.size; x++)
            row.push(qr.getModule(x, y));
        matrix.push(row);
    }
    return matrix;
}
/**
 * Render a QR matrix as a terminal string using Unicode half-block characters,
 * mirroring `qrcode`'s `type:'utf8'` output (each text row packs two module
 * rows). A dark module renders as the terminal foreground; light as background.
 */
export function renderTerminalQr(text, opts = {}) {
    const margin = opts.margin ?? 2;
    const matrix = encodeQrMatrix(text);
    const size = matrix.length;
    const full = size + margin * 2;
    // dark(x,y) with quiet-zone offset; out-of-range => light.
    const dark = (x, y) => {
        const mx = x - margin;
        const my = y - margin;
        if (mx < 0 || my < 0 || mx >= size || my >= size)
            return false;
        return matrix[my][mx];
    };
    const lines = [];
    for (let y = 0; y < full; y += 2) {
        let line = '';
        for (let x = 0; x < full; x++) {
            const top = dark(x, y);
            const bottom = y + 1 < full ? dark(x, y + 1) : false;
            if (top && bottom)
                line += '█'; // █
            else if (top && !bottom)
                line += '▀'; // ▀
            else if (!top && bottom)
                line += '▄'; // ▄
            else
                line += ' ';
        }
        lines.push(line);
    }
    return lines.join('\n');
}
