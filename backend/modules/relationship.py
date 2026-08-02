from enum import Enum

class RelationshipType(Enum):   
    SIG_OTHER = "sigother"              #girlfriends/boyfriends/etc.
    PARENT = "parent"                   #dad/mom/guardian
    CLOSE_FAMILY = "close_family"       #sibling/cousins
    FAMILY = "family"                   #uncles/aunts/etc.
    CLOSE_FRIENDS = "close_friend"      #best_friends
    FRIEND = "friend"
    CLASSMATE = "classmate"
    PROFESSOR = "professor"
    COWORKER = "coworker"
    BOSS = "boss"
    OTHER = "other"


