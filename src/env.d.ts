// Parts of the File System Access API that only Chromium browsers implement,
// and that TypeScript's DOM types therefore leave out.

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

interface DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
}

// Local Network Access (Chrome 142 and later): the address space a request is meant to
// reach. Requests to the DiskAtlas Helper declare 'loopback'.
interface RequestInit {
  targetAddressSpace?: 'loopback' | 'local' | 'public';
}

// User-Agent Client Hints (Chromium): used to offer the helper only on Windows desktops.
interface NavigatorUAData {
  readonly platform: string;
  readonly mobile: boolean;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
