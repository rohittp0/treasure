# TreasureHunch

A geography treasure hunt where a seeker follows clues to find a hidden country on a map.

## Language

**Hunt**:
A timed attempt to find one hidden country by following three clues.
_Avoid_: Quiz, level

**Seeker**:
The player trying to find the hidden country.
_Avoid_: Guessing user

**Hidden country**:
The country containing the treasure and the correct answer to a hunt.

**Clue**:
One of three progressively more revealing hints about the hidden country. The first clue is free; later clues cost remaining time.

**Guess**:
A confirmed country selection. Selecting or canceling a country alone is not a guess.

**Time cost**:
Seconds deducted from the hunt's remaining time to pay for a wrong guess, another clue, or a country-name reveal.

**Country-name reveal**:
Help that names the hidden country after all three clues have been opened.

**Daily quest**:
The one hunt of the UTC day, with the same hidden country for every seeker. Each seeker gets one attempt.

**Claim**:
Finding the daily quest's country adds it to the seeker's explorer map. Countries are claimed only through daily quests.

**Explorer map**:
A public world map of the countries a seeker has claimed. It can be shared by link.
_Avoid_: Atlas (used in code only)

**Monthly leaderboard**:
The main public ranking: the most daily-quest countries found this month, with ties broken by the least total time used.

**Leaderboard**:
The all-time ranking: the weighted average time used across won solo levels and daily-quest finds. A daily find weighs double the seeker's highest solo level.

**Hider**:
The player who chooses a hidden country and challenges a seeker to find it.

**Friend hunt result**:
The story of a completed challenge between a hider and a seeker. Finding the treasure is a seeker victory; running out of time is a hider victory.

**Victory poster**:
A shareable keepsake of the winner's challenge, including both participants, the hidden country and the seeker's hunt statistics.

**Explorer**:
A player with an account and a username, signed in with WhatsApp (the primary way) or Google. An explorer becomes a seeker during a hunt.
_Avoid_: User, account (outside code)

**Daily quest alert**:
The one message each UTC day that announces the new daily quest, sent by browser push and, for opted-in explorers, on WhatsApp. It is the only message ever sent on WhatsApp apart from verification codes.
_Avoid_: Daily challenge, daily notification

**Verified number**:
A WhatsApp number an explorer has proven they own with a one-time code. One number belongs to at most one explorer, and it can be used to sign in.

**WhatsApp opt-in**:
An explorer's explicit, revocable consent to get the daily quest alert on their verified number. Verifying a number, signing in with WhatsApp or allowing browser notifications is not opt-in on its own; ticking the unticked consent box, including the one offered while signing in with WhatsApp, is.
_Avoid_: WhatsApp subscription

**Opt-out**:
Withdrawing WhatsApp opt-in, by replying STOP, by using the unsubscribe link in the alert, or from settings. The verified number is kept for sign-in.

## Flagged ambiguities

- "Daily challenge" was used to mean the **daily quest**. Resolved: "challenge" is reserved for friend hunts, and the day's hunt is always the **daily quest**.
