# Moodle Course Quick Open

## Description
This repository contains a Tampermonkey script that turns Moodle into a keyboard-first command center. It indexes courses, activities, resources, sections, and recent activity so you can jump across the LMS from any Moodle page.

## Features
- Global command palette for Moodle navigation.
- Whole-site course tree indexing from dashboard/course listing pages and discovered course pages.
- Cross-course search, so `linear take home` can find an assignment inside Linear Algebra while you are in another course.
- Semester-aware ranking, so newer courses like `In23-S4` are prioritized over older matches such as `In23-S2`.
- Filters for all results, courses, activities, current course, sections, recent activity, and commands.
- Recent activity indexing to prioritize changed courses during refreshes.
- Persistent Moodle dark mode.
- Moodle focus mode to hide side drawers/blocks while reading.
- Compact course layout mode to tighten activity cards and sections.
- Built-in commands for refreshing the index, opening the dashboard, opening the current course, opening recent activity, clearing cache, and changing result density.
- Smart lecture note downloader for the current course using conservative PDF/PPT/PPTX lecture-resource detection.
- Local browser cache, so search works from deep activity pages without needing to rediscover courses every time.

## Prerequisites
- Tampermonkey or a similar userscript extension.
- A Moodle account with access to the courses you want indexed.

## Installation
1. Install the Tampermonkey extension for your browser.
2. Create a new script in Tampermonkey and paste the contents of `script.js`.
3. Save the script.

## Configuration
The script includes a `CONFIG` object at the top of `script.js`:

```js
const CONFIG = {
    targetSite: "online.uom.lk",
    shortcut: { ctrl: true, shift: true, key: "k" },
    darkModeShortcut: { ctrl: true, shift: true, key: "l" },
    maxResults: 24,
    cacheHours: 12,
    fullIndexBatchSize: 4,
    fuzzySearch: true
};
```

Configuration notes:
- `targetSite`: Moodle hostname where the script should run.
- `shortcut`: opens the command center.
- `darkModeShortcut`: toggles persistent dark mode.
- `maxResults`: maximum palette results.
- `cacheHours`: how often the index is considered stale.
- `fullIndexBatchSize`: how many course pages to fetch at once during full indexing.
- `fuzzySearch`: allows approximate keyboard-style matching.

## Usage
1. Navigate to your Moodle site, for example `https://online.uom.lk`.
2. Press `Ctrl+Shift+K` to open the command center.
3. Type a search and press Enter to open the selected result.

Examples:
- `linear take home` searches the whole indexed LMS tree.
- `course: programming languages` searches courses.
- `module: quiz` searches activities across all indexed courses.
- `current: lecture` searches only the current course.
- `section: week 4` searches course sections.
- `recent: assignment` searches recent activity.
- `command: dark` finds the dark-mode toggle.
- `command: focus` toggles Moodle focus mode.
- `command: compact course` toggles the compact course layout.
- `command: download lecture notes` downloads likely lecture notes/slides from the current course.

Keyboard controls:
- `Arrow Up` / `Arrow Down`: move selection.
- `Enter`: open or run selected result.
- `Tab` / `Shift+Tab`: cycle filters.
- `Ctrl+R`: refresh the full index.
- `Esc`: close the command center.
- `Ctrl+Shift+L`: toggle Moodle dark mode.

The first full index refresh can take a little while because the script visits each discovered course page in the background using your logged-in browser session. Later searches use the cached index and refresh periodically.

## Notes
The script prefers Moodle pages and logged-in browser access over requiring an admin API token. If a Moodle site exposes useful AJAX or web-service endpoints to the logged-in user, those can be added later as faster index providers while keeping the HTML indexer as a fallback.

## Contributing
Contributions are welcome. Fork this repository and submit a pull request with your changes.

## License
This project is licensed under the MIT License. See the LICENSE file for details.

## Author
[Malindu Bandara](https://github.com/thisismalindu)
