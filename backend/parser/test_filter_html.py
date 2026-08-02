from bs4 import BeautifulSoup

#Work with Command Line Arguments Later / Loop over all messages
soup = BeautifulSoup(open("raw-export/rithvik.html", "r"), features="html.parser")

messages = soup.find_all('div', "message")
print(messages)
print("\n" * 50)
print(len(messages))
print(messages[1])