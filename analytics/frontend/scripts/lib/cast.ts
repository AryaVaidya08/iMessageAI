// The fixed cast shared by the chat.db and AddressBook generators so contacts line up with handles.
import { makeRng } from "./rng";

export interface Person {
  /** handle.id as stored in chat.db (E.164 phone or lower-case email) */
  handle: string;
  first: string;
  last: string;
  org?: string;
  /** phones as typed in the address book (deliberately differently formatted) */
  abPhones: string[];
  abEmails: string[];
  /** whether this person appears in the AddressBook fixture */
  inAddressBook: boolean;
}

const NAMED: Person[] = [
  { handle: "+15551110001", first: "Alice", last: "Anders", abPhones: ["(555) 111-0001"], abEmails: [], inAddressBook: true },
  { handle: "+15551110002", first: "Bob", last: "Baker", abPhones: ["555-111-0002", "+1 555 111 9999"], abEmails: ["bob@example.com"], inAddressBook: true },
  { handle: "carol@example.com", first: "Carol", last: "Chen", abPhones: [], abEmails: ["Carol@Example.com"], inAddressBook: true },
  { handle: "+447911123456", first: "Dev", last: "Dhillon", abPhones: ["+44 7911 123456"], abEmails: [], inAddressBook: true }, // international
  { handle: "+15551110005", first: "Erin", last: "Evans", abPhones: ["1 (555) 111-0005"], abEmails: [], inAddressBook: true },
  { handle: "+15551110006", first: "", last: "", org: "Pizza Palace", abPhones: ["555.111.0006"], abEmails: [], inAddressBook: true }, // org-only
  { handle: "+15551110007", first: "Frank", last: "Fox", abPhones: [], abEmails: [], inAddressBook: false }, // unknown number
  { handle: "grace@example.org", first: "Grace", last: "Gray", abPhones: [], abEmails: [], inAddressBook: false },
];

/** `count` people: the named cast first, then procedurally generated unknown numbers. */
export function makeCast(count: number): Person[] {
  const out = NAMED.slice(0, Math.min(count, NAMED.length)).map((p) => ({ ...p }));
  const rng = makeRng(777);
  for (let i = out.length; i < count; i++) {
    out.push({
      handle: `+1555${String(2000000 + i * 7 + rng.int(0, 6)).padStart(7, "0")}`,
      first: `Person${i}`,
      last: "Gen",
      abPhones: [],
      abEmails: [],
      inAddressBook: false,
    });
  }
  return out;
}

export const NAMED_CAST_SIZE = NAMED.length;
