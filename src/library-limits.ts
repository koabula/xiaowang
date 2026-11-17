export const LIBRARY_BYTE_CAP = 80 * 1024 * 1024;
export const librarySizeError = (bytes: number, limit = LIBRARY_BYTE_CAP) => `文件有 ${bytes} 字节，超过 ${limit} 字节。`;
