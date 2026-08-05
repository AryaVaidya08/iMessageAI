from bs4 import BeautifulSoup
import bs4
import os
from tqdm import tqdm
from datetime import datetime
from backend.modules import Tapback, Message, Announcement, Participant, Conversation, RelationshipType
import uuid
import nanoid

PERSONAL_NUMBER = "+19088424785"

os.system("clear")

files = os.listdir("./backend/parser/raw_export")
files.remove(".gitkeep")
files.remove("+18482295363.html")
files.remove("+17328536966.html")
files.sort()
#files = ["+19082104570.html", "+19083324481, +19082104570, +19088641540.html"]

participants: dict[str, Participant] = {}
currentParticipants: dict[str, Participant] = {}

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

def extractMessages(soup):
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

            error_tags = tag("span", attrs="attachment_error", recursive=False)         #Remove
            unsent_tags = tag("span", attrs="unsent", recursive=False)                  #Remove
            app_tags = tag("div", attrs="app", recursive=False)                         #Remove
            app_error_tags = tag("div", attrs="app_error", recursive=False)             #Remove


            if len(bubble_tags):
                message_text = bubble_tags[0].getText()
            elif len(attachment_tags):
                attachment = True
            elif len(sticker_tags):
                sticker = True
            elif len(edited_tags):
                message_text = edited_tags[0]("tfoot")[0]("td")[-1].getText()
            else:
                #Useless Message
                continue

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

    def extractReplyIDs(originalReplyDict : dict, originalID : str, reply_tags : list[bs4.element.Tag]):
        replies : list[bs4.element.Tag] = reply_tags[0]("div", attrs="reply", recursive=False)

        for reply in replies:
            originalReplyDict[reply["id"]] = originalID

        return originalReplyDict

    replyDict = {}

    allMessages : list[Message] = []
    for message in messages[:]:

        #print(message.prettify())
        
        #print("-" * 50)
        subClass = "received" if len(message("div", attrs="received", recursive=False)) == 1 else "sent"
        actualMesssage : bs4.element.Tag = message("div", subClass, recursive=False)[0]
        #Health Checks
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

        tapbacks = None
        tapback_tags = actualMesssage("div", attrs="tapbacks", recursive=False)
        if len(tapback_tags) == 1:
            tapbacks : list[Tapback] = extract_tapbacks(tapback_tags[0]("div", attrs="tapback"))


        reply_message_id = None
        reply_tags = actualMesssage("div", attrs="replies", recursive=False)
        if len(reply_tags) == 1:                                                #THIS IS A BASE MESSAGE WITH REPLIES
            
            replyDict = extractReplyIDs(replyDict, messageID, reply_tags)
        elif len(actualMesssage.find_all("span", attrs="reply_context")) == 1:  #THIS IS A REPLY TO A PREVIOUS MESSAGE
            try:
                reply_message_id = replyDict[messageID]
            except:
                #Just throw away --> could be a reply to either a link, app, blank, or media error
                print("KEY ERROR WITH REPLY")
                continue


        messageObj = Message(id=messageID, sender_id=participant.id, timestamp=timestamp, 
                                text=text, has_attachment=has_attachment, has_sticker=has_sticker, 
                                tapbacks=tapbacks, reply_to=reply_message_id)

        allMessages.append(messageObj)
        #print(f"""Message(id={messageID}, sender_id={participant.id}, timestamp={timestamp}, 
        #text=\"{text}\", has_attachment={has_attachment}, has_sticker={has_sticker}, 
        #tapbacks={tapbacks}, reply_to={reply_message_id})\n""")
        #print("=" * 20)

    return allMessages

def extractAnnouncements(soup):
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
        affected_id = None

        if actionWord == "unsent":      #unsent message
            action = "unsent message"           
        elif actionWord == "added":
            action = "added person"
            affected_id = actionStrs[2]
            if affected_id == "You":
                affected_id = PERSONAL_NUMBER
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
                affected_id = actionStrs[2]
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

        newAnnouncement = Announcement(datetime=timestamp, announcer_id=participant.id, 
                     action=action, affected_id=affected_id)

        allAnnouncements.append(newAnnouncement)

        #print(f"""Announcement(datetime={timestamp}, announcer_id={participant.id},
        #     action=\"{action}\", affected_id={affected_id})\n""")
    return allAnnouncements

def runProgram(fileName : str):
    global currentParticipants
    #Work with Command Line Arguments Later / Loop over all messages
    currentParticipants = {}
    soup = BeautifulSoup(open(fileName, "r"), features="html.parser")

    messages = extractMessages(soup)
    announcements = extractAnnouncements(soup)

    convoID = nanoid.generate(size=16)

    #RelationshipType temp set to other
    newConversation = Conversation(id=convoID, is_group_chat=len(currentParticipants) > 2 or fileName.count(",") > 0, 
                                   participants=currentParticipants, relationship_type=RelationshipType.OTHER,
                                   messages=messages, announcements=announcements)

    #print(f"""Conversation(id={convoID}, is_group_chat={len(currentParticipants) > 2 or fileName.count(",") > 0}, 
    #         participants={len(currentParticipants)}, relationship_type={RelationshipType.OTHER},
    #         messages={len(messages)}, announcements={len(announcements)})\n""")


for i in range(len(files)):
    print(f"---- {files[i]} ({i}/{len(files)}) ----")
    runProgram("./backend/parser/raw_export/"+files[i])

