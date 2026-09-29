export declare const Backend: {
    DesktopSize: typeof DesktopSize;
    InputTransaction: typeof InputTransaction;
    SessionBuilder: typeof SessionBuilder;
    ClipboardData: typeof ClipboardData;
    DeviceEvent: typeof DeviceEvent;
};

declare class ClipboardData {
    free(): void;
    [Symbol.dispose](): void;
    addBinary(mime_type: string, binary: Uint8Array): void;
    addText(mime_type: string, text: string): void;
    constructor();
    isEmpty(): boolean;
    items(): ClipboardItem_2[];
}

declare class ClipboardItem_2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    mimeType(): string;
    value(): any;
}

declare class DesktopSize {
    free(): void;
    [Symbol.dispose](): void;
    constructor(width: number, height: number);
    height: number;
    width: number;
}

declare class DeviceEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static keyPressed(scancode: number): DeviceEvent;
    static keyReleased(scancode: number): DeviceEvent;
    static mouseButtonPressed(button: number): DeviceEvent;
    static mouseButtonReleased(button: number): DeviceEvent;
    static mouseMove(x: number, y: number): DeviceEvent;
    static unicodePressed(unicode: string): DeviceEvent;
    static unicodeReleased(unicode: string): DeviceEvent;
    static wheelRotations(vertical: boolean, rotation_amount: number, rotation_unit: RotationUnit): DeviceEvent;
}

export declare function displayControl(enable: boolean): Extension;

/**
 * Result of initiating a file download via {@link RdpFileTransferProvider.downloadFile}.
 */
export declare interface DownloadHandle {
    /** Unique identifier for this download, available synchronously before the download completes */
    transferId: number;
    /** Promise that resolves with the downloaded file blob */
    completion: Promise<Blob>;
}

/**
 * A file extracted from a drag-and-drop event, with optional path metadata
 * from directory traversal via the File and Directory Entries API.
 *
 * When a folder is dropped, its contents are recursively enumerated and each
 * file is returned with a {@link path} relative to the drop root.  Directory
 * entries themselves are included with {@link isDirectory} set to `true` and a
 * `null` {@link file} handle (they carry no data, only structure).
 */
export declare interface DroppedFile {
    /** Browser File handle.  `null` for directory-only entries. */
    file: File | null;
    /** File or directory basename (e.g. `"report.pdf"` or `"images"`). */
    name: string;
    /** Size in bytes.  Always 0 for directory entries. */
    size: number;
    /** Last-modified timestamp (ms since Unix epoch, same as `File.lastModified`). */
    lastModified: number;
    /**
     * Relative directory path within the dropped collection, using `\` as
     * separator to match the Windows wire convention (MS-RDPECLIP 3.1.1.2).
     * `undefined` for entries at the drop root.
     *
     * @example
     * // File "photo.png" inside dropped folder "docs/images":
     * { name: "photo.png", path: "docs\\images", ... }
     */
    path?: string;
    /** Whether this entry represents a directory rather than a file. */
    isDirectory?: boolean;
}

export declare function enableCredssp(enable: boolean): Extension;

/** One physical monitor, in the RDP coordinate space. Right/bottom are inclusive. (ARA fork) */
export declare type MonitorRect = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    primary?: boolean;
};

/** Advertise a multi-monitor layout ([MS-RDPBCGR] 2.2.1.3.6 TS_UD_CS_MONITOR). (ARA fork — ara-multimonitor.patch) */
export declare function monitorLayout(monitors: MonitorRect[]): Extension;

declare type EventHandler<T extends unknown[]> = (...args: T) => void;

declare type EventMap = {
    'download-progress': [TransferProgress];
    'upload-progress': [TransferProgress];
    'download-complete': [FileInfo, Blob, number, number];
    'upload-complete': [File, number, number];
    /** Emitted when an upload batch begins (both initial paste and re-paste).
     *  Provides the full batch of transferIds and DroppedFile metadata so
     *  listeners can register all transfers eagerly before progress events arrive. */
    'upload-batch-started': [Map<number, number>, DroppedFile[]];
    'files-available': [FileInfo[]];
    error: [FileTransferError];
};

declare class Extension {
    free(): void;
    [Symbol.dispose](): void;
    constructor(ident: string, value: any);
}

/**
 * Minimal session interface for extension-based file transfer.
 * Protocol-agnostic - only requires invokeExtension().
 */
declare interface ExtensionSession {
    invokeExtension(ext: Extension): unknown;
}

/**
 * FileContentsFlags values per [MS-RDPECLIP] 2.2.5.3
 *
 * Used in FileContentsRequest to specify the type of operation.
 */
export declare const FileContentsFlags: {
    /**
     * Request file size (8-byte unsigned integer).
     * When set: position must be 0, size must be 8.
     */
    readonly SIZE: 1;
    /**
     * Request byte range from file.
     * When set: position and size define the requested range.
     */
    readonly RANGE: 2;
};

export declare type FileContentsFlags = (typeof FileContentsFlags)[keyof typeof FileContentsFlags];

/**
 * File contents request from remote (when remote requests file upload from client).
 *
 * The client should read the requested file chunk and respond via CLIPRDR.
 */
export declare interface FileContentsRequest {
    /** Stream identifier for this file transfer */
    streamId: number;
    /** File index in the file list (0-based) */
    index: number;
    /**
     * FileContentsFlags bitmask - use FileContentsFlags.SIZE or FileContentsFlags.RANGE
     * - FileContentsFlags.SIZE (0x1): Request file size
     * - FileContentsFlags.RANGE (0x2): Request byte range
     */
    flags: number;
    /** Byte offset for RANGE requests */
    position: number;
    /** Number of bytes requested for RANGE requests */
    size: number;
    /** Optional clipboard lock ID from LockClipData PDU */
    dataId?: number;
}

export declare function fileContentsRequestCallback(cb: (request: {
    streamId: number;
    index: number;
    flags: number;
    position: number;
    size: number;
    dataId?: number;
}) => void): Extension;

/**
 * File contents response from remote (when remote sends file download to client).
 *
 * This is the response to a client's file contents request.
 */
export declare interface FileContentsResponse {
    /** Stream identifier for this file transfer */
    streamId: number;
    /** If true, the request failed (data unavailable/access denied) */
    isError: boolean;
    /**
     * Response data:
     * - For SIZE requests: 8-byte little-endian u64
     * - For RANGE requests: requested byte range
     */
    data: Uint8Array;
}

export declare function fileContentsResponseCallback(cb: (response: {
    streamId: number;
    isError: boolean;
    data: Uint8Array;
}) => void): Extension;

/**
 * File metadata for file transfer operations.
 *
 * When remote copies files, this metadata is provided to the client.
 * File names are limited to 259 characters per MS-RDPECLIP spec.
 */
export declare interface FileInfo {
    /** File basename (including extension, without directory path) */
    name: string;
    /**
     * Relative directory path within the copied collection.
     * Uses `\` as separator (matching the Windows wire protocol convention).
     * Absent or undefined for root-level files.
     *
     * Per MS-RDPECLIP 3.1.1.2, file lists use relative paths to describe
     * directory structure (e.g., `"temp\\subdir"`).
     *
     * @example
     * // File at root level:
     * { name: "readme.txt", size: 100, lastModified: 0 }
     * // File inside "docs" folder:
     * { name: "report.pdf", path: "docs", size: 2048, lastModified: 0 }
     * // File inside nested folder:
     * { name: "image.png", path: "docs\\images", size: 4096, lastModified: 0 }
     */
    path?: string;
    /** File size in bytes (0 for empty files or unknown size) */
    size: number;
    /**
     * Last write time as a JavaScript timestamp (milliseconds since Unix epoch,
     * same as `File.lastModified`). The WASM layer converts to Windows FILETIME
     * for the RDP protocol. 0 indicates unknown or not applicable.
     */
    lastModified: number;
    /**
     * Whether this entry represents a directory rather than a file.
     * Directory entries are used to describe the folder structure of a copied
     * collection and typically have size 0.
     */
    isDirectory?: boolean;
}

export declare function filesAvailableCallback(cb: (files: FileInfo[], clipDataId?: number) => void): Extension;

/**
 * Error information for file transfer operations.
 */
export declare interface FileTransferError {
    /** Error message */
    message: string;
    /** Unique transfer identifier (if applicable) */
    transferId?: number;
    /** File index that failed (if applicable) */
    fileIndex?: number;
    /** File name that failed (if applicable) */
    fileName?: string;
    /** Transfer direction that caused the error (if applicable) */
    direction?: 'download' | 'upload';
    /** Underlying error cause */
    cause?: unknown;
}

export declare function init(log_level: string): Promise<void>;

export declare function initiateFileCopy(files: FileInfo[]): Extension;

declare class InputTransaction {
    free(): void;
    [Symbol.dispose](): void;
    addEvent(event: DeviceEvent): void;
    constructor();
}

export declare function kdcProxyUrl(url: string): Extension;

export declare function lockCallback(cb: (dataId: number) => void): Extension;

export declare function locksExpiredCallback(cb: (clipDataIds: Uint32Array) => void): Extension;

export declare function outboundMessageSizeLimit(limit: number): Extension;

export declare function preConnectionBlob(pcb: string): Extension;

export declare function printerDeviceId(id: number): Extension;

export declare const PrinterDriverName: {
    readonly PostScript: "MS Publisher Imagesetter";
    readonly MicrosoftPrintToPdf: "Microsoft Print to PDF";
};

export declare function printerDriverName(driverName: string): Extension;

export declare function printerName(name: string): Extension;

export declare interface PrintJobStreamCallbacks {
    onJobStart?: (fileId: number) => void;
    onJobData: (fileId: number, chunk: Uint8Array) => void;
    onJobComplete: (fileId: number) => void;
    onJobError?: (fileId: number) => void;
}

export declare function printJobStreamCallbacks(callbacks: PrintJobStreamCallbacks): Extension;

export declare class RdpFile {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    getInt(key: string): number | undefined;
    getStr(key: string): string | undefined;
    insertInt(key: string, value: number): void;
    insertStr(key: string, value: string): void;
    parse(config: string): void;
    write(): string;
}

/**
 * RdpFileTransferProvider provides a high-level API for bidirectional file transfer
 * in browser-based RDP sessions.
 *
 * This class wraps the low-level WASM file transfer API and handles:
 * - State management for downloads and uploads
 * - Chunking and reassembly
 * - Progress tracking
 * - Browser integration helpers (file picker, drag-and-drop)
 *
 * ## Clipboard Locking
 *
 * Clipboard locks are managed automatically by the Rust cliprdr processor. When
 * the remote copies files (FormatList containing FileGroupDescriptorW), a lock
 * is acquired automatically. The lock ID is passed to RdpFileTransferProvider via
 * the filesAvailable callback and used in all subsequent FileContentsRequest
 * PDUs. Lock lifecycle (expiry on clipboard change, Unlock PDU emission) is
 * handled entirely by the Rust layer - no explicit lock/unlock calls are needed.
 *
 * ## Error Handling Best Practices
 *
 * Production applications should implement comprehensive error handling:
 *
 * @example Basic Usage
 * ```typescript
 * const provider = new RdpFileTransferProvider({ chunkSize: 64 * 1024 });
 * component.enableFileTransfer(provider);
 * await component.connect(config);
 *
 * // Handle downloads from remote
 * provider.on('files-available', async (files) => {
 *   for (const file of files) {
 *     const { completion } = provider.downloadFile(file, files.indexOf(file));
 *     const blob = await completion;
 *     saveAs(blob, file.name);
 *   }
 * });
 *
 * // Handle uploads using file picker
 * const files = await provider.showFilePicker({ multiple: true });
 * provider.uploadFiles(files);
 * ```
 *
 * @example Error Handling
 * ```typescript
 * provider.on('error', (error) => {
 *   console.error('Transfer error:', error.message);
 *   if (error.fileName) {
 *     showNotification(`Failed to transfer ${error.fileName}: ${error.message}`);
 *   }
 * });
 * ```
 *
 * @example Handling Lock Expiration
 * ```typescript
 * provider.on('error', (error) => {
 *   if (error.message.includes('lock expired')) {
 *     showNotification(
 *       'File download timed out',
 *       'The transfer took too long. Try a faster connection or smaller files.',
 *       'warning'
 *     );
 *   }
 * });
 * ```
 */
export declare class RdpFileTransferProvider {
    /** Maximum file size for downloads (2GB) to prevent browser out-of-memory errors */
    private static readonly MAX_FILE_SIZE;
    /** Timeout for FileReader operations (60 seconds) to prevent stalled uploads */
    private static readonly FILE_READER_TIMEOUT_MS;
    /** Maximum recursion depth when traversing dropped directories. */
    private static readonly MAX_DIRECTORY_DEPTH;
    /** Maximum total entries (files + directories) collected from a single drop. */
    private static readonly MAX_DIRECTORY_ENTRIES;
    private session?;
    private readonly chunkSize;
    private readonly onUploadStarted?;
    private readonly onUploadFinished?;
    private readonly eventHandlers;
    private activeDownloads;
    private uploadState?;
    private retainedFiles?;
    private availableFiles;
    private clipDataId?;
    private nextStreamId;
    private disposed;
    constructor(options?: RdpFileTransferProviderOptions);
    /**
     * Set the session instance after connection is established.
     * Called by the web component's connect() flow via the FileTransferProvider interface.
     */
    setSession(session: ExtensionSession): void;
    private ensureSession;
    private sendRequestFileContents;
    private sendSubmitFileContents;
    private sendInitiateFileCopy;
    /**
     * Returns the extension objects to register on the SessionBuilder before connect().
     * Implements the FileTransferProvider interface.
     */
    getBuilderExtensions(): Extension[];
    /**
     * Register an event handler.
     *
     * @param event - Event name
     * @param handler - Event handler function
     *
     * @example
     * ```typescript
     * manager.on('download-progress', (progress) => {
     *   console.log(`${progress.fileName}: ${progress.percentage}%`);
     * });
     * ```
     */
    on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
    /**
     * Unregister an event handler.
     *
     * @param event - Event name
     * @param handler - Event handler function to remove
     */
    off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
    /**
     * Emit an event to all registered handlers.
     */
    private emit;
    /**
     * Download a single file from the remote.
     *
     * Returns a {@link DownloadHandle} with a `transferId` available synchronously
     * (for immediate UI association) and a `completion` promise that resolves with
     * the downloaded blob.
     *
     * @param fileInfo - File metadata from 'files-available' event
     * @param fileIndex - Index of the file in the original file list
     * @returns Handle with synchronous transferId and async completion
     *
     * @example
     * ```typescript
     * const { transferId, completion } = manager.downloadFile(fileInfo, 0);
     * // transferId is available immediately for UI binding
     * const blob = await completion;
     * saveAs(blob, fileInfo.name);
     * ```
     */
    downloadFile(fileInfo: FileInfo, fileIndex: number): DownloadHandle;
    /**
     * Internal: execute the async download workflow for a single file.
     */
    private executeDownload;
    /**
     * Download multiple files sequentially.
     *
     * @param files - Array of FileInfo from 'files-available' event
     * @returns AsyncGenerator yielding file/blob pairs as they complete
     *
     * @example
     * ```typescript
     * for await (const { file, blob } of manager.downloadFiles(files)) {
     *   saveAs(blob, file.name);
     * }
     * ```
     */
    downloadFiles(files: FileInfo[]): AsyncGenerator<{
        file: FileInfo;
        blob: Blob;
        transferId: number;
    }>;
    /**
     * Download multiple files concurrently with configurable parallelism.
     *
     * This method initiates multiple file downloads in parallel, improving
     * performance for multi-file transfers. Each file uses an independent
     * clipboard lock and stream ID.
     *
     * @param files - Array of FileInfo from 'files-available' event
     * @param options - Download options
     * @param options.maxConcurrent - Maximum concurrent downloads (default: 3)
     * @returns Promise resolving to map of fileIndex to Blob
     *
     * @example
     * ```typescript
     * const blobs = await manager.downloadFilesConcurrent(files, { maxConcurrent: 5 });
     * files.forEach((file, i) => saveAs(blobs.get(i)!, file.name));
     * ```
     */
    downloadFilesConcurrent(files: FileInfo[], options?: {
        maxConcurrent?: number;
    }): Promise<Map<number, Blob>>;
    /**
     * Upload files to the remote.
     *
     * Returns an {@link UploadHandle} with per-file `transferIds` available
     * synchronously (for immediate UI association) and a `completion` promise
     * that resolves when all files have been uploaded.
     *
     * @param files - Array of File objects to upload
     * @returns Handle with synchronous transferIds and async completion
     *
     * @example
     * ```typescript
     * const files = await manager.showFilePicker({ multiple: true });
     * const { transferIds, completion } = manager.uploadFiles(files);
     * // transferIds available immediately for UI binding
     * await completion;
     * ```
     */
    uploadFiles(files: File[] | DroppedFile[]): UploadHandle;
    /**
     * Show a file picker dialog and return selected files.
     *
     * Note: This must be called in response to a user gesture (e.g., button click)
     * due to browser security restrictions.
     *
     * @param options - File picker options
     * @returns Promise resolving to selected File objects
     *
     * @example
     * ```typescript
     * button.onclick = async () => {
     *   const files = await manager.showFilePicker({ multiple: true, accept: 'image/*' });
     *   await manager.uploadFiles(files);
     * };
     * ```
     */
    showFilePicker(options?: {
        multiple?: boolean;
        accept?: string;
    }): Promise<File[]>;
    /**
     * Extract files (and recursively traverse directories) from a drag-and-drop event.
     *
     * Uses the File and Directory Entries API (`webkitGetAsEntry`) which is
     * supported across all major browsers (Chrome, Firefox, Safari, Edge).
     * Falls back to `getAsFile()` when the Entries API is unavailable.
     *
     * Directory entries are included in the result with `isDirectory: true`
     * and a `null` file handle.  Files inside directories have their
     * {@link DroppedFile.path} set to the relative backslash-separated path.
     *
     * @param event - DragEvent from drop handler
     * @returns Promise resolving to an array of DroppedFile descriptors
     *
     * @example
     * ```typescript
     * dropZone.addEventListener('drop', async (e) => {
     *   const files = await manager.handleDrop(e);
     *   manager.uploadFiles(files);
     * });
     * ```
     */
    handleDrop(event: DragEvent): Promise<DroppedFile[]>;
    /**
     * Normalize a plain `File[]` or `DroppedFile[]` into `DroppedFile[]`.
     * Allows `uploadFiles` to accept either type for backward compatibility.
     */
    private static normalizeToDroppedFiles;
    /**
     * Recursively traverse a FileSystemEntry, collecting files and directory
     * entries into `results`.
     */
    private traverseEntry;
    /**
     * Read all entries from a FileSystemDirectoryReader.  Chromium-based
     * browsers return at most 100 entries per `readEntries()` call, so we
     * must loop until an empty batch is returned.
     */
    private static readAllDirectoryEntries;
    /**
     * Prevent default drag-over behavior to enable drop target.
     *
     * This must be called in the dragover event handler for drag-and-drop to work.
     *
     * @param event - DragEvent from dragover handler
     *
     * @example
     * ```typescript
     * dropZone.addEventListener('dragover', (e) => manager.handleDragOver(e));
     * ```
     */
    handleDragOver(event: DragEvent): void;
    /**
     * Cleanup resources and unregister callbacks.
     *
     * Call this when the session is terminating or RdpFileTransferProvider is no longer needed.
     */
    dispose(): void;
    private handleFilesAvailable;
    /* Excluded from this release type: sanitizeFileName */
    /* Excluded from this release type: sanitizePath */
    private handleFileContentsRequest;
    /**
     * Lazily rebuild uploadState from retainedFiles when the remote re-pastes
     * after the original upload completed. This lets the main code path in
     * handleFileContentsRequest handle progress and completion identically.
     * No external promise - resolve/reject are no-ops.
     */
    private rebuildUploadStateFromRetained;
    private handleFileContentsResponse;
    private handleLock;
    private handleUnlock;
    private handleLocksExpired;
    private requestNextChunk;
    private generateStreamId;
}

/**
 * Configuration options for RdpFileTransferProvider.
 */
export declare interface RdpFileTransferProviderOptions {
    /**
     * Chunk size in bytes for file transfers.
     * Default: 65536 (64KB)
     */
    chunkSize?: number;
    /**
     * Called when an upload begins (before the FormatList is sent to the remote).
     * Use this to suppress clipboard monitoring so the 100ms polling loop does
     * not clobber the file upload's FormatList with a text/image update.
     */
    onUploadStarted?: () => void;
    /**
     * Called when an upload finishes (success, failure, or dispose).
     * Use this to resume clipboard monitoring after {@link onUploadStarted}.
     */
    onUploadFinished?: () => void;
}

export declare function requestFileContents(params: {
    stream_id: number;
    file_index: number;
    flags: number;
    position: number;
    size: number;
    clip_data_id?: number;
}): Extension;

declare enum RotationUnit {
    Pixel = 0,
    Line = 1,
    Page = 2,
}

declare class Session {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    applyInputs(transaction: InputTransaction): void;
    desktopSize(): DesktopSize;
    invokeExtension(ext: Extension): any;
    onClipboardPaste(content: ClipboardData): Promise<void>;
    releaseAllInputs(): void;
    resize(width: number, height: number, scale_factor?: number | null, physical_width?: number | null, physical_height?: number | null): void;
    run(): Promise<SessionTerminationInfo>;
    shutdown(): void;
    supportsUnicodeKeyboardShortcuts(): boolean;
    synchronizeLockKeys(scroll_lock: boolean, num_lock: boolean, caps_lock: boolean, kana_lock: boolean): void;
}

declare class SessionBuilder {
    free(): void;
    [Symbol.dispose](): void;
    authToken(token: string): SessionBuilder;
    canvasResizedCallback(callback: Function): SessionBuilder;
    connect(): Promise<Session>;
    constructor();
    desktopSize(desktop_size: DesktopSize): SessionBuilder;
    destination(destination: string): SessionBuilder;
    extension(ext: Extension): SessionBuilder;
    forceClipboardUpdateCallback(callback: Function): SessionBuilder;
    password(password: string): SessionBuilder;
    proxyAddress(address: string): SessionBuilder;
    remoteClipboardChangedCallback(callback: Function): SessionBuilder;
    renderCanvas(canvas: HTMLCanvasElement): SessionBuilder;
    serverDomain(server_domain: string): SessionBuilder;
    setCursorStyleCallback(callback: Function): SessionBuilder;
    setCursorStyleCallbackContext(context: any): SessionBuilder;
    username(username: string): SessionBuilder;
}

declare class SessionTerminationInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    reason(): string;
}

export declare function submitFileContents(params: {
    stream_id: number;
    is_error: boolean;
    data: Uint8Array;
}): Extension;

/**
 * Progress information for file transfer operations.
 */
export declare interface TransferProgress {
    /** Unique identifier for this transfer operation, stable across the lifetime of the transfer */
    transferId: number;
    /** File index in the transfer list */
    fileIndex: number;
    /** File name */
    fileName: string;
    /** Number of bytes transferred so far */
    bytesTransferred: number;
    /** Total file size in bytes */
    totalBytes: number;
    /** Transfer progress as percentage (0-100) */
    percentage: number;
}

export declare function unlockCallback(cb: (dataId: number) => void): Extension;

/**
 * Result of initiating a file upload via {@link RdpFileTransferProvider.uploadFiles}.
 */
export declare interface UploadHandle {
    /** Map of file index to unique transfer identifier for each file in the batch */
    transferIds: Map<number, number>;
    /** Promise that resolves when all files in the batch have been uploaded */
    completion: Promise<void>;
}

export { }
