"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const path = __importStar(require("path"));
const logParser_1 = require("../../src/latex/logParser");
suite('LogParser Test Suite', () => {
    let logParser;
    setup(() => {
        logParser = new logParser_1.LogParser();
    });
    teardown(() => {
        logParser.dispose();
    });
    test('should parse LaTeX errors', () => {
        const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
        const entries = logParser.parse(path.join(fixturesDir, 'sample-errors.log'), fixturesDir);
        const errors = entries.filter((e) => e.type === 'error');
        assert.ok(errors.length > 0, 'Should find at least one error');
        assert.ok(errors.some((e) => e.message.includes('Undefined control sequence')), 'Should find undefined control sequence error');
    });
    test('should parse LaTeX warnings', () => {
        const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
        const entries = logParser.parse(path.join(fixturesDir, 'sample-warnings.log'), fixturesDir);
        const warnings = entries.filter((e) => e.type === 'warning');
        assert.ok(warnings.length > 0, 'Should find at least one warning');
    });
    test('should return empty array for missing file', () => {
        const entries = logParser.parse('/nonexistent/file.log', '/tmp');
        assert.strictEqual(entries.length, 0);
    });
    test('should parse clean log without errors', () => {
        const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
        const entries = logParser.parse(path.join(fixturesDir, 'sample.log'), fixturesDir);
        const errors = entries.filter((e) => e.type === 'error');
        assert.strictEqual(errors.length, 0, 'Clean log should have no errors');
    });
});
//# sourceMappingURL=logParser.test.js.map