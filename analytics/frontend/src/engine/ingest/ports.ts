// Minimal interfaces for units this orchestrator depends on.
// Real implementations (units 1-4) are wired in deps.ts.

export interface Fingerprint {
  size: number;
  maxRowid: number;
  messageCount: number;
  chatCount: number;
  /** Optional: count/max of non-null date_edited + date_retracted so edit-only changes alter the fingerprint. */
  editSignal?: number;
}

export interface ChatInfo {
  guid: string; // conversation_id
  rowid: number; // chat.db chat ROWID
  name: string;
  isGroup: boolean;
  maxRowid: number; // max message ROWID in this chat
  messageCount: number;
}

export interface ExtractedMessage {
  rowid: number;
  guid: string;
  date: string; // ISO UTC
  dateEdited: string | null;
  dateRetracted: string | null;
  isFromMe: boolean;
  senderHandle: string | null; // normalized; null when from me ('me' derives from is_from_me)
  text: string | null;
  service: string | null;
  [extra: string]: unknown;
}

/** One batch for one chat. Opaque extras (tapbacks etc.) are passed to the writer untouched. */
export interface MessageBatch {
  messages: ExtractedMessage[];
  tapbacks?: unknown[];
  announcements?: unknown[];
  participants?: { handle: string }[];
}

export interface EditState {
  rowid: number;
  guid: string;
  dateEdited: string | null;
  dateRetracted: string | null;
}

export interface ChatDbReader {
  fingerprint(): Promise<Fingerprint>;
  listChats(): Promise<ChatInfo[]>;
  close(): Promise<void>;
}

export interface MessageExtractor {
  /** Messages with ROWID > afterRowid in ROWID order, one batch at a time. */
  extractChat(
    chat: ChatInfo,
    opts: { afterRowid: number; batchSize: number },
  ): AsyncGenerator<MessageBatch>;
  /** Edit/retract state for messages with any edit/retract set (<= batchSize per yield). */
  scanEditState(chat: ChatInfo, batchSize: number): AsyncGenerator<EditState[]>;
  /** Re-extract specific messages by ROWID. */
  fetchMessages(chat: ChatInfo, rowids: number[]): Promise<MessageBatch>;
}

export interface ChatStoredState {
  maxRowid: number;
  count: number;
}

export interface AppDbWriter {
  getSyncState(key: string): Promise<string | null>;
  setSyncState(key: string, value: string): Promise<void>;
  getChatState(chatGuid: string): Promise<ChatStoredState>;
  upsertConversation(chat: ChatInfo): Promise<void>;
  /**
   * Insert-or-ignore on guid; ONE transaction that also writes `sync` key/values
   * (resume-safe). Returns number of rows actually inserted.
   */
  writeBatch(chat: ChatInfo, batch: MessageBatch, sync: Record<string, string>): Promise<number>;
  getEditStates(
    guids: string[],
  ): Promise<Map<string, { dateEdited: string | null; dateRetracted: string | null }>>;
  /** Update date_edited/date_retracted/text of existing messages. One transaction. */
  applyEdits(chat: ChatInfo, batch: MessageBatch): Promise<number>;
  close?(): Promise<void>;
}

export interface ContactsImporter {
  importContacts(files: File[], writer: AppDbWriter): Promise<number>;
}

export interface IngestDeps {
  reader: ChatDbReader;
  extractor: MessageExtractor;
  writer: AppDbWriter;
  contacts?: ContactsImporter;
  /** Optional step run after contacts and before planning (e.g. register every handle as a participant). */
  preflight?: () => Promise<void>;
}
