// The keyboard shortcuts, as shown in the help dialog. main.js handles the keys themselves.
// "Ctrl" means Cmd on a Mac.

export const SHORTCUTS = [
  {
    title: 'Write notes',
    items: [
      [['0', '…', '9'], 'Fret number on the current string. Type two digits quickly for 10 to 24.'],
      [['↑', '↓'], 'Choose the string'],
      [['←', '→'], 'Previous or next beat. At the end of a bar, → adds a new beat.'],
      [['Ctrl', '←', '→'], 'Previous or next bar'],
      [['Home', 'End'], 'First or last beat of the bar'],
      [['Delete'], 'Remove the note. On an empty beat, remove the beat.'],
      [['Backspace'], 'Same as Delete, then step back'],
      [['I'], 'Insert a beat here'],
      [['Enter'], 'New bar after this one (Shift+Enter: before)'],
    ],
  },
  {
    title: 'Note length',
    items: [
      [['-', '='], 'Shorter or longer note (whole, half, quarter, eighth, 16th, 32nd)'],
      [['.'], 'Dotted note'],
      [['T'], 'Triplet'],
      [['R'], 'Make the beat a rest'],
    ],
  },
  {
    title: 'Techniques',
    items: [
      [['H'], 'Hammer-on or pull-off to the next note'],
      [['S'], 'Slide to the next note'],
      [['B'], 'Bend: full, then half, then one and a half, then off'],
      [['V'], 'Vibrato'],
      [['X'], 'Dead (muted) note'],
      [['G'], 'Ghost note'],
      [['N'], 'Natural harmonic'],
      [['P'], 'Palm mute'],
      [['D', 'U'], 'Down or up strum'],
      [['Shift', 'T'], 'Chord name or text above the beat'],
      [['Shift', 'M'], 'Section label, like Verse or Chorus'],
    ],
  },
  {
    title: 'Play and practice',
    items: [
      [['Space'], 'Play or pause from the cursor'],
      [['Esc'], 'Stop, or clear the selection'],
      [['L'], 'Loop the selection or the current bar'],
      [['M'], 'Metronome on or off'],
      [['C'], 'Count-in: off, 1 bar, 2 bars'],
      [['[', ']'], 'Practice speed slower or faster'],
      [['Shift', 'N'], 'Show or hide standard notation above the tab'],
    ],
  },
  {
    title: 'Edit',
    items: [
      [['Shift', '←', '→'], 'Select beats (with Ctrl: whole bars)'],
      [['Ctrl', 'A'], 'Select everything'],
      [['Ctrl', 'C'], 'Copy'],
      [['Ctrl', 'X'], 'Cut'],
      [['Ctrl', 'V'], 'Paste after the cursor'],
      [['Ctrl', 'Z'], 'Undo'],
      [['Ctrl', 'Y'], 'Redo (also Ctrl+Shift+Z)'],
      [['Ctrl', 'Delete'], 'Delete the beat'],
      [['Ctrl', 'Shift', 'Delete'], 'Delete the bar'],
      [['Ctrl', 'S'], 'Download the song file'],
      [['Ctrl', 'O'], 'Open a song'],
      [['?'], 'This help'],
    ],
  },
];
