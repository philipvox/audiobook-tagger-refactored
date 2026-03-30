//! Static lookup tables for validation.
//!
//! These are built from analysis of the actual library data and
//! contain known patterns, canonical mappings, and ownership rules.

use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};

// ============================================================================
// INVALID AUTHORS (publishers, organizations, placeholders)
// ============================================================================

pub static INVALID_AUTHORS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        // Publishers/Editors
        "charles river editors",
        "the princeton review",
        "pimsleur language programs",
        "pimsleur",
        "innovative language learning",
        "the great courses",
        "new thought institute",
        "harvard business review",
        "editors of reader's digest",
        "readers digest",
        "time-life books",
        "lonely planet",
        "fodor's travel",
        "frommer's",
        "dk publishing",
        "national geographic",
        // Media organizations
        "this american life",
        "the washington post fact checker staff",
        "bbc",
        "npr",
        "cnn",
        "new york times",
        // Invalid entries
        "phd",
        "md",
        "various authors",
        "multiple authors",
        "anonymous",
        "traditional",
        "unknown",
        "unknown author",
        "none",
        "null",
        "n/a",
        "na",
        "",
        "author",
        "audiobook",
        "narrator",
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// AUTHOR CANONICAL MAPPINGS (lowercase key -> canonical form)
// ============================================================================

pub static AUTHOR_CANONICAL: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    [
        // Diacritics normalization
        ("arnaldur indridason", "Arnaldur Indriðason"),
        ("arnaldur indriðason", "Arnaldur Indriðason"),
        ("asa larsson", "Åsa Larsson"),
        ("åsa larsson", "Åsa Larsson"),
        ("jo nesbo", "Jo Nesbø"),
        ("jo nesbø", "Jo Nesbø"),
        ("samuel bjork", "Samuel Bjørk"),
        ("samuel bjørk", "Samuel Bjørk"),
        ("junot diaz", "Junot Díaz"),
        ("junot díaz", "Junot Díaz"),
        ("wanda gag", "Wanda Gág"),
        ("wanda gág", "Wanda Gág"),
        ("christian moerk", "Christian Mørk"),
        ("christian mørk", "Christian Mørk"),
        ("hakan nesser", "Håkan Nesser"),
        ("håkan nesser", "Håkan Nesser"),
        ("jorn lier horst", "Jørn Lier Horst"),
        ("jørn lier horst", "Jørn Lier Horst"),
        ("emile zola", "Émile Zola"),
        ("émile zola", "Émile Zola"),
        ("gabriel garcia marquez", "Gabriel García Márquez"),
        ("gabriel garcía márquez", "Gabriel García Márquez"),
        ("roberto bolano", "Roberto Bolaño"),
        ("roberto bolaño", "Roberto Bolaño"),
        // Initial spacing variants (extensive)
        ("c.s. lewis", "C. S. Lewis"),
        ("c. s. lewis", "C. S. Lewis"),
        ("cs lewis", "C. S. Lewis"),
        ("j.k. rowling", "J. K. Rowling"),
        ("jk rowling", "J. K. Rowling"),
        ("j. k. rowling", "J. K. Rowling"),
        ("p.d. james", "P. D. James"),
        ("p. d. james", "P. D. James"),
        ("pd james", "P. D. James"),
        ("j.r.r. tolkien", "J. R. R. Tolkien"),
        ("j. r. r. tolkien", "J. R. R. Tolkien"),
        ("jrr tolkien", "J. R. R. Tolkien"),
        ("e.b. white", "E. B. White"),
        ("e. b. white", "E. B. White"),
        ("eb white", "E. B. White"),
        ("h.a. rey", "H. A. Rey"),
        ("h. a. rey", "H. A. Rey"),
        ("ha rey", "H. A. Rey"),
        ("lj ross", "L. J. Ross"),
        ("l.j. ross", "L. J. Ross"),
        ("l. j. ross", "L. J. Ross"),
        ("m.c. beaton", "M. C. Beaton"),
        ("m. c. beaton", "M. C. Beaton"),
        ("mc beaton", "M. C. Beaton"),
        ("p.d. eastman", "P. D. Eastman"),
        ("p. d. eastman", "P. D. Eastman"),
        ("pd eastman", "P. D. Eastman"),
        ("b.a. paris", "B. A. Paris"),
        ("b. a. paris", "B. A. Paris"),
        ("g.k. chesterton", "G. K. Chesterton"),
        ("g. k. chesterton", "G. K. Chesterton"),
        ("s.e. hinton", "S. E. Hinton"),
        ("s. e. hinton", "S. E. Hinton"),
        ("r.f. kuang", "R. F. Kuang"),
        ("r. f. kuang", "R. F. Kuang"),
        ("v.e. schwab", "V. E. Schwab"),
        ("v. e. schwab", "V. E. Schwab"),
        ("n.k. jemisin", "N. K. Jemisin"),
        ("n. k. jemisin", "N. K. Jemisin"),
        ("j.m. barrie", "J. M. Barrie"),
        ("j. m. barrie", "J. M. Barrie"),
        ("w.p. kinsella", "W. P. Kinsella"),
        ("w. p. kinsella", "W. P. Kinsella"),
        ("wp kinsella", "W. P. Kinsella"),
        ("j.d. vance", "J. D. Vance"),
        ("j. d. vance", "J. D. Vance"),
        ("a.j. finn", "A. J. Finn"),
        ("a. j. finn", "A. J. Finn"),
        ("a.a. milne", "A. A. Milne"),
        ("a. a. milne", "A. A. Milne"),
        ("c.j. sansom", "C. J. Sansom"),
        ("c. j. sansom", "C. J. Sansom"),
        ("c.j. tudor", "C. J. Tudor"),
        ("c. j. tudor", "C. J. Tudor"),
        ("m.j. arlidge", "M. J. Arlidge"),
        ("m. j. arlidge", "M. J. Arlidge"),
        ("k.l. slater", "K. L. Slater"),
        ("k. l. slater", "K. L. Slater"),
        ("k. l . slater", "K. L. Slater"), // actual variant in data
        ("s.d. monaghan", "S. D. Monaghan"),
        ("s. d. monaghan", "S. D. Monaghan"),
        ("b.p. walter", "B. P. Walter"),
        ("b. p. walter", "B. P. Walter"),
        ("b p walter", "B. P. Walter"),
        ("r.j. bailey", "R. J. Bailey"),
        ("r. j. bailey", "R. J. Bailey"),
        ("rj bailey", "R. J. Bailey"),
        ("tj klune", "TJ Klune"),
        ("t.j. klune", "TJ Klune"),
        ("lj andrews", "LJ Andrews"),
        ("l.j. andrews", "LJ Andrews"),
        ("george r.r. martin", "George R. R. Martin"),
        ("george r. r. martin", "George R. R. Martin"),
        ("james s.a. corey", "James S. A. Corey"),
        ("james s. a. corey", "James S. A. Corey"),
        ("john le carre", "John le Carré"),
        ("john le carré", "John le Carré"),
        ("ursula k. le guin", "Ursula K. Le Guin"),
        ("ursula k le guin", "Ursula K. Le Guin"),
        // Dr. Seuss variants
        ("dr seuss", "Dr. Seuss"),
        ("dr. seuss", "Dr. Seuss"),
        ("theo lesieg", "Theo LeSieg"),
        // Name format variations
        ("tomie depaola", "Tomie dePaola"),
        ("tomie de paola", "Tomie dePaola"),
        // J.D. Robb / Nora Roberts (pen name - keep as published)
        ("j.d. robb", "J. D. Robb"),
        ("j. d. robb", "J. D. Robb"),
        ("jd robb", "J. D. Robb"),
        // Additional author variants found in data
        ("octavia butler", "Octavia E. Butler"),
        ("octavia e butler", "Octavia E. Butler"),
        ("octavia e. butler", "Octavia E. Butler"),
        ("j.m. clarke", "J. M. Clarke"),
        ("jm clarke", "J. M. Clarke"),
        ("james w hall", "James W. Hall"),
        ("james w. hall", "James W. Hall"),
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// AUTHOR NAMES INCORRECTLY USED AS SERIES
// ============================================================================

pub static AUTHOR_AS_SERIES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        // Children's authors (very common error)
        "dr. seuss",
        "dr seuss",
        "eric carle",
        "eric carle's very",  // "Eric Carle's Very Hungry Caterpillar" etc. used as series
        "the world of beatrix potter",
        "leo lionni",
        "jan brett",
        "william steig",
        "arnold lobel",
        "tomie depaola",
        "tomie de paola",
        "robert mccloskey",
        "ezra jack keats",
        "kevin henkes",
        "mo willems",
        "sandra boynton",
        "audrey wood",
        "don wood",
        "audrey and don wood",
        "roald dahl",
        "beatrix potter",
        "maurice sendak",
        "cynthia rylant",
        "wanda gag",
        "wanda gág",
        "ludwig bemelmans",
        "h. a. rey",
        "h.a. rey",
        "bernard waber",
        "russell hoban",
        "mercer mayer",
        "syd hoff",
        "else holmelund minarik",
        "p. d. eastman",
        "p.d. eastman",
        "james marshall",
        "mary ann hoberman",
        "judi barrett",
        "judith viorst",
        "joyce dunbar",
        "simms taback",
        "stephanie calmenson",
        "iza trapani",
        "sam mcbratney",
        "kathi appelt",
        "nadine bernard westcott",
        "peggy rathmann",
        "peggy rathman",  // common misspelling
        "paul galdone",
        "rosemary wells",
        "marjorie weinman sharmat",
        "bill martin jr.",
        "bill martin",
        "bernard most",
        "barbara cooney",
        "anna hines",
        "ann mcgovern",
        // Other authors commonly misattributed as series
        "george orwell",
        "stephen king",
        "nora roberts",
        "james patterson",
        "agatha christie",
        "anne perry",
        "peter robinson",
        "ian rankin",
        "jo nesbo",
        "jo nesbø",
        "val mcdermid",
        "karin slaughter",
        "louise penny",
        "tana french",
        "michael connelly",
        "lee child",
        "john grisham",
        "dan brown",
        "clive cussler",
        "tom clancy",
        "robert ludlum",
        "vince flynn",
        "daniel silva",
        "terry pratchett",
        "neil gaiman",
        "brandon sanderson",
        "patrick rothfuss",
        "joe abercrombie",
        "brent weeks",
        "sarah j. maas",
        "sarah j maas",
        "rebecca yarros",
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// INVALID SERIES (publishers, formats, placeholders)
// ============================================================================

pub static INVALID_SERIES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        // Publisher imprints
        "beginner",  // GPT sometimes shortens "Beginner Books"
        "beginner books",
        "bright and early",  // GPT sometimes shortens "Bright and Early Books"
        "bright and early books",
        "chartwell deluxe editions",
        "penguin classics",
        "audible originals",
        "recorded books",
        "read with highlight",
        "voices leveled library",
        "voices leveled library readers",
        "rebus read-along stories",
        "smart summaries",
        "kindle unlimited",
        "prime reading",
        // Language courses (not book series)
        "pimsleur",
        "pimsleur farsi",
        "pimsleur spanish",
        "pimsleur french",
        "pimsleur german",
        "pimsleur italian",
        "pimsleur japanese",
        "pimsleur chinese",
        "pimsleur arabic",
        "pimsleur russian",
        "pimsleur portuguese",
        // Media/podcasts
        "this american life",
        "where should we begin",
        "the butterfly effect with jon ronson",
        // Generic terms
        "chapter",
        "memoir",
        "parenting",
        "fiction",
        "novel",
        "novels",
        "complete",
        "collection",
        "treasury",
        "omnibus",
        "anthology",
        "greatest mysteries of all time",
        "the greatest mysteries of all time",
        "greatest mysteries",
        "none",
        "null",
        "n/a",
        "na",
        "unknown",
        "unknown series",
        "or null",
        "standalone",
        "stand-alone",
        "stand alone",
        "single",
        "single book",
        "not a series",
        "no series",
        // Format descriptors
        "unabridged",
        "abridged",
        "full cast",
        "dramatized",
        "audiobook",
        "audio",
        "mp3",
        "m4b",
        "book",
        "story",
        "non-fiction",
        "part",
        "volume",
        "edition",
        "box set",
        "manga shakespeare",
        "graphic shakespeare",
        "graphic novel",
        "comic adaptation",
        "illustrated edition",
        "pop-up book",
        "board book",
        // Shakespeare adaptations/editions (not actual series)
        "shakespeare stories",
        "the 30-minute shakespeare",
        "30-minute shakespeare",
        "the signet classic shakespeare",
        "signet classic shakespeare",
        "bloom's modern critical interpretations",
        "landmarks of world literature",
        // Generic literary categories
        "comedies",
        "tragedies",
        "histories",
        // Garbage found in actual data
        "jag badalnare granth",
        "test",
        // French language series (non-English metadata)
        "petits meurtres",
        "petits meurtres français",
        // Award/marketing
        "timeless classic",
        "timeless classics",
        "classic literature",
        "great books",
        "must read",
        "bestseller",
        "bestsellers",
        "award winner",
        "award winners",
        "pulitzer prize",
        "new york times bestseller",
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// SERIES CANONICAL MAPPINGS
// ============================================================================

pub static SERIES_CANONICAL: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    [
        // Thomas Pitt variants
        ("charlotte & thomas pitt", "Thomas Pitt"),
        ("charlotte and thomas pitt", "Thomas Pitt"),
        ("charlotte and thomas pitt mysteries", "Thomas Pitt"),
        ("the charlotte and thomas pitt novels", "Thomas Pitt"),
        ("the charlotte and thomas pitt", "Thomas Pitt"),
        ("thomas pitt mystery", "Thomas Pitt"),
        ("thomas pitt", "Thomas Pitt"),
        // Inspector Gamache variants
        ("chief inspector armand gamache", "Inspector Gamache"),
        ("chief inspector gamache", "Inspector Gamache"),
        ("chief inspector gamache mysteries", "Inspector Gamache"),
        ("gamache", "Inspector Gamache"),
        ("inspector gamache", "Inspector Gamache"),
        ("three pines", "Inspector Gamache"),
        // Inspector Banks variants
        ("inspector banks", "Inspector Banks"),
        ("alan banks", "Inspector Banks"),
        ("dci banks", "Inspector Banks"),
        ("banks", "Inspector Banks"),
        // Other detective series
        ("adam dalgliesh", "Adam Dalgliesh"),
        ("inspector rebus", "Inspector Rebus"),
        ("rebus", "Inspector Rebus"),
        ("inspector van veeteren", "Inspector Van Veeteren"),
        ("van veeteren", "Inspector Van Veeteren"),
        ("d.d. warren", "D.D. Warren"),
        ("detective d.d. warren", "D.D. Warren"),
        ("d.i. kim stone", "DI Kim Stone"),
        ("di kim stone", "DI Kim Stone"),
        ("d.i. lottie parker", "DI Lottie Parker"),
        ("di lottie parker", "DI Lottie Parker"),
        ("d.i. nikki galena", "DI Nikki Galena"),
        ("di nikki galena", "DI Nikki Galena"),
        ("tony hill & carol jordan", "Tony Hill & Carol Jordan"),
        ("tony hill and carol jordan", "Tony Hill & Carol Jordan"),
        ("tony hill & carol jordan #2", "Tony Hill & Carol Jordan"),
        ("tony hill and carol jordan #2", "Tony Hill & Carol Jordan"),
        ("karen pirie", "Inspector Karen Pirie"),
        ("inspector karen pirie", "Inspector Karen Pirie"),
        ("william wisting", "William Wisting"),
        ("william wisting [english order]", "William Wisting"),
        // Children's series
        ("mr. putter & tabby", "Mr. Putter & Tabby"),
        ("mr. putter and tabby", "Mr. Putter & Tabby"),
        (
            "magic tree house merlin mission",
            "Magic Tree House: Merlin Missions",
        ),
        (
            "magic tree house merlin missions",
            "Magic Tree House: Merlin Missions",
        ),
        (
            "magic tree house: merlin missions",
            "Magic Tree House: Merlin Missions",
        ),
        ("merlin missions", "Magic Tree House: Merlin Missions"),
        (
            "magic tree house \"merlin missions\"",
            "Magic Tree House: Merlin Missions",
        ),
        ("franklin", "Franklin"),
        ("franklin the turtle", "Franklin"),
        ("frances the badger", "Frances"),
        ("frances", "Frances"),
        ("curious george", "Curious George"),
        ("curious george original adventures", "Curious George"),
        ("danny and the dinosaur", "Danny and the Dinosaur"),
        ("little bear", "Little Bear"),
        ("henry and mudge", "Henry and Mudge"),
        ("henry & mudge", "Henry and Mudge"),
        ("froggy", "Froggy"),
        ("amelia bedelia", "Amelia Bedelia"),
        ("george and martha", "George and Martha"),
        ("madeline", "Madeline"),
        ("strega nona", "Strega Nona"),
        ("harold", "Harold"),
        ("lyle the crocodile", "Lyle"),
        ("lyle", "Lyle"),
        ("caps for sale", "Caps for Sale"),
        ("five little monkeys", "Five Little Monkeys"),
        ("cobble street cousins", "Cobble Street Cousins"),
        ("the cobble street cousins", "Cobble Street Cousins"),
        // Fantasy/Sci-Fi series
        ("the expanse", "The Expanse"),
        ("the expanse (chronological)", "The Expanse"),
        ("outlander", "Outlander"),
        ("outlander (gabaldon)", "Outlander"),
        ("a song of ice and fire", "A Song of Ice and Fire"),
        ("game of thrones", "A Song of Ice and Fire"),
        ("discworld", "Discworld"),
        // Discworld subseries with prefix
        ("discworld - ankh-morpork city watch", "Discworld"),
        ("discworld - death", "Discworld"),
        ("discworld - industrial revolution", "Discworld"),
        ("discworld - moist von lipwig", "Discworld"),
        ("discworld - rincewind", "Discworld"),
        ("discworld - tiffany aching", "Discworld"),
        ("discworld - witches", "Discworld"),
        ("discworld - wizards", "Discworld"),
        ("discworld - watch", "Discworld"),
        // Discworld subseries WITHOUT prefix (from some providers like Storytel)
        // These are unique enough to not be confused with other series
        ("moist von lipwig", "Discworld"),
        ("tiffany aching", "Discworld"),
        ("rincewind", "Discworld"),
        ("ankh-morpork city watch", "Discworld"),
        ("ankh morpork city watch", "Discworld"),
        // Note: "death", "witches", "watch", "wizards" are too generic
        ("the dresden files", "Dresden Files"),
        ("dresden files", "Dresden Files"),
        ("cradle", "Cradle"),
        ("first law", "First Law"),
        ("first law world", "First Law"),
        ("the first law", "First Law"),
        ("lightbringer", "Lightbringer"),
        ("red rising", "Red Rising"),
        ("red rising saga", "Red Rising"),
        ("earthsea", "Earthsea"),
        ("earthsea cycle", "Earthsea"),
        ("kingkiller chronicle", "Kingkiller Chronicle"),
        ("the kingkiller chronicle", "Kingkiller Chronicle"),
        ("throne of glass", "Throne of Glass"),
        ("a court of thorns and roses", "A Court of Thorns and Roses"),
        ("crescent city", "Crescent City"),
        ("empyrean", "Empyrean"),
        ("the bone season", "Bone Season"),
        ("bone season", "Bone Season"),
        ("zodiac academy", "Zodiac Academy"),
        ("the bridge kingdom", "Bridge Kingdom"),
        ("bridge kingdom", "Bridge Kingdom"),
        ("the hunger games", "Hunger Games"),
        ("hunger games", "Hunger Games"),
        ("the dark tower", "Dark Tower"),
        ("dark tower", "Dark Tower"),
        ("the vampire chronicles", "Vampire Chronicles"),
        ("vampire chronicles", "Vampire Chronicles"),
        // Gentleman Bastard series
        ("gentleman bastard", "Gentleman Bastard"),
        ("the gentleman bastard sequence", "Gentleman Bastard"),
        ("gentleman bastard sequence", "Gentleman Bastard"),
        // Wars of the Roses
        ("the war of the roses", "Wars of the Roses"),
        ("war of the roses", "Wars of the Roses"),
        ("wars of the roses", "Wars of the Roses"),
        // Kindred's Curse
        ("the kindred's curse saga", "Kindred's Curse Saga"),
        ("kindred's curse", "Kindred's Curse Saga"),
        // Other
        ("arkangel shakespeare", "Arkangel Shakespeare"),
        ("the complete arkangel shakespeare", "Arkangel Shakespeare"),
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// SERIES OWNERSHIP (series name -> valid authors)
// ============================================================================

pub static SERIES_OWNERSHIP: Lazy<HashMap<&'static str, Vec<&'static str>>> = Lazy::new(|| {
    [
        // Detective/Mystery
        ("inspector banks", vec!["peter robinson"]),
        ("adam dalgliesh", vec!["p. d. james", "p.d. james"]),
        ("hercule poirot", vec!["agatha christie"]),
        ("miss marple", vec!["agatha christie"]),
        ("inspector rebus", vec!["ian rankin"]),
        ("harry hole", vec!["jo nesbø", "jo nesbo"]),
        ("cormoran strike", vec!["robert galbraith", "j. k. rowling"]),
        ("inspector gamache", vec!["louise penny"]),
        (
            "inspector erlendur",
            vec!["arnaldur indriðason", "arnaldur indridason"],
        ),
        (
            "inspector van veeteren",
            vec!["håkan nesser", "hakan nesser"],
        ),
        ("roy grace", vec!["peter james"]),
        ("di kim stone", vec!["angela marsons"]),
        ("alex morrow", vec!["denise mina"]),
        ("hamish macbeth", vec!["m. c. beaton", "m.c. beaton"]),
        ("d.d. warren", vec!["lisa gardner"]),
        ("helen grace", vec!["m. j. arlidge", "m.j. arlidge"]),
        ("dublin murder squad", vec!["tana french"]),
        ("tony hill & carol jordan", vec!["val mcdermid"]),
        ("inspector karen pirie", vec!["val mcdermid"]),
        ("simon serrailler", vec!["susan hill"]),
        ("joseph o'loughlin", vec!["michael robotham"]),
        ("frieda klein", vec!["nicci french"]),
        ("department q", vec!["jussi adler-olsen"]),
        ("joona linna", vec!["lars kepler"]),
        (
            "rebecka martinsson",
            vec!["åsa larsson", "asa larsson"],
        ),
        (
            "william wisting",
            vec!["jørn lier horst", "jorn lier horst"],
        ),
        ("slough house", vec!["mick herron"]),
        ("thomas pitt", vec!["anne perry"]),
        ("william monk", vec!["anne perry"]),
        // Thriller
        ("gabriel allon", vec!["daniel silva"]),
        ("jack ryan", vec!["tom clancy"]),
        ("mitch rapp", vec!["vince flynn"]),
        ("terminal list", vec!["jack carr"]),
        ("jack reacher", vec!["lee child"]),
        ("pendergast", vec!["douglas preston", "lincoln child"]),
        // Fantasy/Sci-Fi
        ("discworld", vec!["terry pratchett"]),
        ("dresden files", vec!["jim butcher"]),
        ("cradle", vec!["will wight"]),
        ("first law", vec!["joe abercrombie"]),
        ("lightbringer", vec!["brent weeks"]),
        ("red rising", vec!["pierce brown"]),
        ("the expanse", vec!["james s. a. corey", "james s.a. corey"]),
        ("earthsea", vec!["ursula k. le guin"]),
        ("kingkiller chronicle", vec!["patrick rothfuss"]),
        ("stormlight archive", vec!["brandon sanderson"]),
        ("mistborn", vec!["brandon sanderson"]),
        (
            "throne of glass",
            vec!["sarah j. maas", "sarah j maas"],
        ),
        (
            "a court of thorns and roses",
            vec!["sarah j. maas", "sarah j maas"],
        ),
        ("crescent city", vec!["sarah j. maas", "sarah j maas"]),
        ("empyrean", vec!["rebecca yarros"]),
        ("dark tower", vec!["stephen king"]),
        ("harry potter", vec!["j. k. rowling", "j.k. rowling"]),
        // Children's
        ("amelia bedelia", vec!["peggy parish", "herman parish"]),
        (
            "curious george",
            vec!["h. a. rey", "h.a. rey", "margret rey"],
        ),
        ("frances", vec!["russell hoban"]),
        ("froggy", vec!["jonathan london"]),
        ("little bear", vec!["else holmelund minarik"]),
        ("henry and mudge", vec!["cynthia rylant"]),
        ("mr. putter & tabby", vec!["cynthia rylant"]),
        ("magic tree house", vec!["mary pope osborne"]),
        (
            "magic tree house: merlin missions",
            vec!["mary pope osborne"],
        ),
        ("madeline", vec!["ludwig bemelmans"]),
        ("strega nona", vec!["tomie depaola", "tomie de paola"]),
        ("franklin", vec!["paulette bourgeois"]),
        ("lyle", vec!["bernard waber"]),
        ("danny and the dinosaur", vec!["syd hoff"]),
        ("harold", vec!["crockett johnson"]),
        ("george and martha", vec!["james marshall"]),
        ("caps for sale", vec!["esphyr slobodkina"]),
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// DISCWORLD ORPHAN SUBSERIES (invalid without parent prefix)
// ============================================================================

pub static DISCWORLD_ORPHANS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "death",
        "witches",
        "watch",
        "city watch",
        "rincewind",
        "tiffany aching",
        "moist von lipwig",
        "industrial revolution",
        "ankh-morpork",
        "wizards",
        "guards",
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// DISCWORLD PUBLICATION ORDER (title -> sequence number)
// Used as fallback when sources don't provide main series sequence
// ============================================================================

pub static DISCWORLD_SEQUENCE: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    [
        ("the colour of magic", "1"),
        ("the light fantastic", "2"),
        ("equal rites", "3"),
        ("mort", "4"),
        ("sourcery", "5"),
        ("wyrd sisters", "6"),
        ("pyramids", "7"),
        ("guards! guards!", "8"),
        ("eric", "9"),
        ("moving pictures", "10"),
        ("reaper man", "11"),
        ("witches abroad", "12"),
        ("small gods", "13"),
        ("lords and ladies", "14"),
        ("men at arms", "15"),
        ("soul music", "16"),
        ("interesting times", "17"),
        ("maskerade", "18"),
        ("feet of clay", "19"),
        ("hogfather", "20"),
        ("jingo", "21"),
        ("the last continent", "22"),
        ("carpe jugulum", "23"),
        ("the fifth elephant", "24"),
        ("the truth", "25"),
        ("thief of time", "26"),
        ("the last hero", "27"),
        ("the amazing maurice and his educated rodents", "28"),
        ("night watch", "29"),
        ("the wee free men", "30"),
        ("monstrous regiment", "31"),
        ("a hat full of sky", "32"),
        ("going postal", "33"),
        ("thud!", "34"),
        ("wintersmith", "35"),
        ("making money", "36"),
        ("unseen academicals", "37"),
        ("i shall wear midnight", "38"),
        ("snuff", "39"),
        ("raising steam", "40"),
        ("the shepherd's crown", "41"),
    ]
    .into_iter()
    .collect()
});

// ============================================================================
// KNOWN CHARACTER-BASED SERIES (valid person names as series)
// ============================================================================

pub static VALID_CHARACTER_SERIES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        // These are valid series even though they're person names
        "harry potter",
        "percy jackson",
        "jack reacher",
        "jack ryan",
        "alex cross",
        "kinsey millhone",
        "kay scarpetta",
        "stephanie plum",
        "peter diamond",
        "william wisting",
        "john keller",
        "johnny merrimon",
        "peter pan",
        "mary russell",
        "adam dalgliesh",
        "cordelia gray",
        "elvis cole",
        "joe pike",
        "lucas davenport",
        "virgil flowers",
        "harry bosch",
        "mickey haller",
        "renee ballard",
        "lincoln rhyme",
        "amelia sachs",
        "cotton malone",
        "gray man",
        "mitch rapp",
        "scot harvath",
        "joe ledger",
        "john puller",
        "amos decker",
        "will trent",
        "faith mitchell",
        "sara linton",
        "jeffrey tolliver",
        "cormoran strike",
        "dave robicheaux",
        "easy rawlins",
        "spenser",
        "jesse stone",
        "sunny randall",
        "myron bolitar",
        "win lockwood",
        "hieronymus bosch",
        "harry hole",
        "peter wimsey",
        "hercule poirot",
        "miss marple",
        "sherlock holmes",
        "nancy drew",
        "hardy boys",
        "inspector banks",
        "inspector gamache",
        "inspector rebus",
    ]
    .into_iter()
    .collect()
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invalid_authors_populated() {
        assert!(INVALID_AUTHORS.contains("charles river editors"));
        assert!(INVALID_AUTHORS.contains("unknown"));
        assert!(!INVALID_AUTHORS.contains("stephen king"));
    }

    #[test]
    fn test_author_canonical_mappings() {
        assert_eq!(
            AUTHOR_CANONICAL.get("jo nesbo"),
            Some(&"Jo Nesbø")
        );
        assert_eq!(
            AUTHOR_CANONICAL.get("j.k. rowling"),
            Some(&"J. K. Rowling")
        );
    }

    #[test]
    fn test_series_ownership() {
        let banks_authors = SERIES_OWNERSHIP.get("inspector banks").unwrap();
        assert!(banks_authors.contains(&"peter robinson"));
    }

    #[test]
    fn test_discworld_orphans() {
        assert!(DISCWORLD_ORPHANS.contains("death"));
        assert!(DISCWORLD_ORPHANS.contains("witches"));
        assert!(!DISCWORLD_ORPHANS.contains("discworld"));
    }
}
