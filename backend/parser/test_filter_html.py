from bs4 import BeautifulSoup
import bs4
import os
from tqdm import tqdm
from datetime import datetime
from backend.modules import Tapback, Message

os.system("clear")

files = os.listdir("./backend/parser/raw_export")
files.sort()

#files = [fileName4]

messageCount = 0
badMessages = 0

def runProgram(fileName):
    global messageCount, badMessages

    #Work with Command Line Arguments Later / Loop over all messages
    soup = BeautifulSoup(open(fileName, "r"), features="html.parser")

    messages = soup.body.find_all('div', "message", recursive=False)
    announcements = soup.body.find_all('div', "announcement", recursive=False)

    #SAVE WORKING FILE FOR EASE OF CHECKING
    #f = open("./output.html", "w")
    #f.write(str(soup.prettify()))

    # Preprocessing: Get rid of the messages with reply-context
    """
    cleanedMessages : list[bs4.element.Tag] = []

    for i in range(len(messages)):
        if len(messages[i].find_all("span", attrs="reply_context")) != 1:
            cleanedMessages.append(messages[i])

    #print(len(messages), "->", len(cleanedMessages))

    """

    # STICKERS CAN BE SENT INDEPENDENTLY
    # IF STICKERS ARE ATTACHED TO A MESSAGE THEY ARE CLASSIFIED AS TAPBACKS (HANDLE THIS PROPERLY)

    """
    <div class="message" id="r-4EB2B2BF-FC0A-407F-ABEF-62057B0EED18">
    <div class="sent iMessage">
    <p> ##_#_#_#_#_#_#_#_#__#_#_#_#_##_#__##_#_ THIS HAS THE METADATA TIMEDATE SENDER
    <hr/> #_#_#_#__#_#_#_#_##_#_#_#_#_#_#_ THIS IS JUST A HORIZONTAL LINE
    <div class="message_part"> ##_#__#_##_#_#_#_#_#_ THIS IS THE ACTUAL TEXT IN THE MESSAGE OR ATTACHMENT
    <div class="tapbacks"> #_#_##_#_# THIS CONTAINS THE POTENTIAL FOR TAPBACKS
    <div class="replies"> #_#_##_#_#_#_THIS LETS US KNOW IF THERE ARE REPLIES TO THE MESSAGE
    <span class="reply_context"> #_#_#_#_ LETS US KNOW IF IT REPLIED TO A PREVIOUS MESSAGE
    </span>
    </div>
    </div>
    """

    #NEED TO ADD HEALTH CHECKS AND ERROR HANDLING FOR ALL FUNCTIONS

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
        #attachment, bubble, edited
        #print(message_tags)

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

    #NEED TO PUT INTO TAPBACK OBJECTS        
    def extract_tapbacks(tapback_tags : list[bs4.element.Tag]):
        tapbacks : list[Tapback] = []
        for tag in tapback_tags:
            tapback_tag : bs4.element.Tag = tag("span", attrs="tapback")
            sticker_tag : bs4.element.Tag = tag("div", attrs="sticker_tapback")

            if len(tapback_tag):
                emoji_action = tapback_tag[0]("b")[0].getText()

                tapback_text = tapback_tag[0].getText()
                sender = tapback_text[tapback_text.index("by")+2:].strip()
                
                #print(emoji_action, sender)
            elif len(sticker_tag):
                sticker_text = sticker_tag[0].getText()
                sender = sticker_text[sticker_text.index("by")+2:].strip()

                #print("Sticker", sender)

        return tapbacks

    def extractReplyIDs(originalReplyDict : dict, originalID : str, reply_tags : list[bs4.element.Tag]):
        replies : list[bs4.element.Tag] = reply_tags[0]("div", attrs="reply", recursive=False)
        #print("*" * 100)
        for reply in replies:
            #print(reply)
            #print()
            originalReplyDict[reply["id"]] = originalID
        #print("*" * 100)
        return originalReplyDict

    replyDict = {}

    messageCount += len(messages)
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
            badMessages += 1
            continue

        #Get Stuff
        messageID, timestamp, sender = extract_metadata(p_tags)
        status = extract_text_or_attachment(text_tags)

        if status != None:
            text, has_attachment, has_sticker = status
        else:
            badMessages += 1
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
                badMessages += 1
                #Just throw away --> could be a reply to either a link, app, blank, or media error
                print("KEY ERROR WITH REPLY")
                continue


        messageObj = Message(id=messageID, sender_id=sender, timestamp=timestamp, 
                             text=text, has_attachment=has_attachment, has_sticker=has_sticker, 
                             tapbacks=tapbacks, reply_to=reply_message_id)

        #print(f"""Message(id={messageID}, sender_id={sender}, timestamp={timestamp}, 
        #text=\"{text}\", has_attachment={has_attachment}, has_sticker={has_sticker}, 
        #tapbacks={tapbacks}, reply_to={reply_message_id})
        #""")

        #print("=" * 20)

for i in range(len(files)):
    print(f"---- {files[i]} ({i}/{len(files)}) ----")
    runProgram("./backend/parser/raw_export/"+files[i])

print(f"Messages Collected: {messageCount - badMessages}/{messageCount} {(((messageCount - badMessages)/messageCount)*100):.3f}%")