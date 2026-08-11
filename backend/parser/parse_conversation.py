import os
import json
import dataclasses
from pathlib import Path
from dotenv import load_dotenv

from backend.modules import Tapback, Message, Announcement, Participant, Conversation, RelationshipType
from datetime import datetime

from bs4 import BeautifulSoup
import bs4

import uuid
import hashlib
import re

load_dotenv(".env.local")
PERSONAL_NUMBER = os.getenv("PERSONAL_NUMBER")

participants: dict[str, Participant] = {}
currentParticipants: dict[str, Participant] = {}

# -- Local Helper Functions --

_GROUP_NAME_PATTERN = re.compile(r"^(.*) - \d+$")

def _extract_convo_name(file_stem: str, is_group_chat: bool) -> str | None:
    if not is_group_chat:
        return None

    match = _GROUP_NAME_PATTERN.match(file_stem)
    if match:
        return match.group(1).strip()

    return None

def _stable_conversation_id(file_name: str) -> str:
    return hashlib.sha256(file_name.encode("utf-8")).hexdigest()[:16]

def _serialize_participant(p: Participant) -> dict:
    d = dataclasses.asdict(p)
    d["id"] = str(d["id"])  # uuid.UUID -> str
    return d

def _deserialize_participant(d: dict) -> Participant:
    d = dict(d)
    d["id"] = uuid.UUID(d["id"])  # str -> uuid.UUID
    return Participant(**d)

def load_participant_registry(path: str | Path) -> None:
    participants.clear()
    p = Path(path)
    if not p.exists():
        return
    data = json.loads(p.read_text())
    for sender, participant_dict in data.items():
        participants[sender] = _deserialize_participant(participant_dict)

def save_participant_registry(path: str | Path) -> None:
    data = {sender: _serialize_participant(p) for sender, p in participants.items()}
    Path(path).write_text(json.dumps(data, indent=2))

def get_or_create_participant(sender: str) -> Participant:
    if sender in participants:
        if sender not in currentParticipants:
            currentParticipants[sender] = participants[sender]
        return participants[sender]

    participant = Participant(id=uuid.uuid4())

    if sender == PERSONAL_NUMBER:
        participant.phone_num = PERSONAL_NUMBER
        participant.is_me = True
    elif "@" in sender:
        participant.email = sender
    else:
        participant.phone_num = sender

    participants[sender] = participant
    currentParticipants[sender] = participant
    return participant

# -- Main Helper Functions --

def extract_messages(soup):
    messages = soup.body.find_all('div', "message", recursive=False)
     
    def extract_metadata(p_tags : list[bs4.element.Tag]):
        metadata_tag = p_tags[0]

        timestamp_tag : bs4.element.Tag = metadata_tag("span", attrs="timestamp", recursive=False)[0]

        anchorTag : bs4.element.Tag = timestamp_tag("a")[0]
        messageID = anchorTag["href"][anchorTag["href"].index("message-guid=") + len("message-guid="):].strip()

        timestampStr : str = anchorTag.getText()
        timestamp = datetime.strptime(timestampStr, "%b %d, %Y %I:%M:%S %p")
        
        sender : bs4.element.Tag = metadata_tag("span", attrs='sender', recursive=False)[0].getText()

        return messageID, timestamp, sender

    def extract_text_or_attachment(message_tags : list[bs4.element.Tag]):
        message_text = ""
        attachment = False
        sticker = False

        for tag in message_tags:
            bubble_tags : list[bs4.element.Tag]= tag("span", attrs="bubble", recursive=False)                  #Keep 
            attachment_tags : list[bs4.element.Tag]= tag("div", attrs="attachment", recursive=False)           #Keep
            sticker_tags : list[bs4.element.Tag] = tag("div", attrs="sticker", recursive=False)                 #Keep
            edited_tags : list[bs4.element.Tag]= tag("div", attrs="edited", recursive=False)                   #Get Last One

            if len(bubble_tags):
                message_text = bubble_tags[0].getText()
            elif len(attachment_tags):
                attachment = True
            elif len(sticker_tags):
                sticker = True
            elif len(edited_tags):
                message_text = edited_tags[0]("tfoot")[0]("td")[-1].getText()

        if len(message_text) == 0 and not attachment and not sticker:
            return None

        return message_text, attachment, sticker            
     
    def extract_tapbacks(tapback_tags : list[bs4.element.Tag]):
        tapbacks : list[Tapback] = []
        for tag in tapback_tags:
            tapback_tag : bs4.element.Tag = tag("span", attrs="tapback")
            sticker_tag : bs4.element.Tag = tag("div", attrs="sticker_tapback")

            if len(tapback_tag):
                action = tapback_tag[0]("b")[0].getText()

                tapback_text = tapback_tag[0].getText()
                sender = tapback_text[tapback_text.index("by")+2:].strip()
            elif len(sticker_tag):
                sticker_text = sticker_tag[0].getText()
                sender = sticker_text[sticker_text.index("by")+2:].strip()
                action = "Sticker"
            else:
                continue

            participant = get_or_create_participant(sender)
            newTapback = Tapback(reactor_id=participant.id, action=action)
            tapbacks.append(newTapback)

        return tapbacks

    def extract_reply_ids(originalReplyDict : dict, originalID : str, reply_tags : list[bs4.element.Tag]):
        replies : list[bs4.element.Tag] = reply_tags[0]("div", attrs="reply", recursive=False)

        for reply in replies:
            originalReplyDict[reply["id"]] = originalID

        return originalReplyDict

    replyDict = {}

    allMessages : list[Message] = []
    for message in messages[:]:
        subClass = "received" if len(message("div", attrs="received", recursive=False)) == 1 else "sent"
        actualMesssage : bs4.element.Tag = message("div", subClass, recursive=False)[0]

        p_tags = actualMesssage("p", recursive=False)
        text_tags = actualMesssage("div", attrs="message_part", recursive=False)

        if not (len(p_tags) <= 2 and len(text_tags) != 0):
            #Health Check
            continue

        #Get Stuff
        messageID, timestamp, sender = extract_metadata(p_tags)
        participant = get_or_create_participant(sender)
        status = extract_text_or_attachment(text_tags)

        if status != None:
            text, has_attachment, has_sticker = status
        else:
            continue

        tapbacks = []
        tapback_tags = actualMesssage("div", attrs="tapbacks", recursive=False)
        if len(tapback_tags) == 1:
            tapbacks : list[Tapback] = extract_tapbacks(tapback_tags[0]("div", attrs="tapback"))


        reply_message_id = None
        reply_tags = actualMesssage("div", attrs="replies", recursive=False)
        if len(reply_tags) == 1:                                                #THIS IS A BASE MESSAGE WITH REPLIES
            replyDict = extract_reply_ids(replyDict, messageID, reply_tags)
        elif len(actualMesssage.find_all("span", attrs="reply_context")) == 1:  #THIS IS A REPLY TO A PREVIOUS MESSAGE
            try:
                reply_message_id = replyDict[messageID]
            except:
                #Just throw away --> could be a reply to either a link, app, blank, or media error
                continue


        messageObj = Message(id=messageID, sender_id=participant.id, timestamp=timestamp, 
                                text=text, has_attachment=has_attachment, has_sticker=has_sticker, 
                                tapbacks=tapbacks, reply_to=reply_message_id)

        allMessages.append(messageObj)

    return allMessages

def extract_announcements(soup):
    allAnnouncements : list[Announcement] = []
    announcements : list[bs4.element.Tag] = soup.body.find_all('div', "announcement", recursive=False)

    for announcement in announcements[:]:
        announcement_tag = announcement("p", recursive=False)[0]
        datetimeStr = announcement_tag("span", attrs="timestamp", recursive=False)[0].getText()

        timestamp : datetime = datetime.strptime(datetimeStr, "%b %d, %Y %I:%M:%S %p")

        actionStrs = announcement_tag.getText()[len(datetimeStr):].strip().split(" ")

        sender = actionStrs[0]
        if sender == "You":
            sender = PERSONAL_NUMBER

        actionWord = actionStrs[1]

        action = ""
        affected = None

        if actionWord == "unsent":      #unsent message
            action = "unsent message"           
        elif actionWord == "added":
            action = "added person"
            affected = actionStrs[2]
            if affected == "You":
                affected = PERSONAL_NUMBER
        elif actionWord == "kept":
            action = "kept audio"
        elif actionWord == "removed":
            if actionStrs[2] == "the":
                if actionStrs[-1] == "background.":
                    action = "removed background"
                elif actionStrs[-1] == "photo.":
                    action = "removed photo"
                else:
                    print("UHOH", ' '.join(actionStrs))
            else:
                action = "removed person"
                affected = actionStrs[2]
        elif actionWord == "left":
            action = "left convo"
        elif actionWord == "named":
            action = "renamed convo"
        elif actionWord == "changed":
            if actionStrs[-1] == "background.":
                action = "changed background"
            elif actionStrs[-1] == "photo.":
                action = "changed photo"
            elif actionStrs[-1] == "number.":
                action = "changed number"
            else:
                print("UHOH", ' '.join(actionStrs))
        else:
            print("We fading ts")

        participant = get_or_create_participant(sender)
        affected_person = None

        if affected != None:
            affected_person = get_or_create_participant(affected)

        annoucementID = hashlib.sha256(f"{timestamp.isoformat()}|{participant.id}|{action}|{affected_person.id if affected_person else ''}".encode()).hexdigest()[:16]

        newAnnouncement = Announcement(annoucement_id=annoucementID, datetime=timestamp, announcer_id=participant.id, 
                                       action=action, affected_id=affected_person.id if affected_person else None)

        allAnnouncements.append(newAnnouncement)

    return allAnnouncements

# -- Main Function --

def parse_conversation(fileName : str):
    global currentParticipants

    currentParticipants = {}

    soup = BeautifulSoup(open(fileName, "r"), features="html.parser")

    messages = extract_messages(soup)
    announcements = extract_announcements(soup)

    convoID = _stable_conversation_id(fileName)

    is_group_chat = len(currentParticipants) > 2 or fileName.count(",") > 0

    file_stem = os.path.splitext(os.path.basename(fileName))[0]
    convo_name = _extract_convo_name(file_stem, is_group_chat)

    #RelationshipType temp set to other
    conversation = Conversation(id=convoID, is_group_chat=len(currentParticipants) > 2 or fileName.count(",") > 0, convo_name=convo_name,
                                   participants=list(currentParticipants.values()), relationship_type=RelationshipType.OTHER,
                                   messages=messages, announcements=announcements)

    return conversation
