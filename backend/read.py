import pyphen

# Written syllable breaks for display (e.g. "im-mer-sive"), not phonetic.
dic = pyphen.Pyphen(lang="en_US")

passage_as_syllables = syllabify(passage)

def syllabify(passage):
    # Use dic.inserted(word) per word; build syllable list with
    # paragraph/word indices (NO SPACES between syllables).
    pass

class syllable(string):
    def __init__():
        self.string = string
        self.next = None
        self.index = "paragraph/word indices"
        pass

# then, need to convert singly linked list to JSON array of syllables