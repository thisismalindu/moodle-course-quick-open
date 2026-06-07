// ==UserScript==
// @name         Moodle Course Quick Open
// @namespace    moodle-quick-open
// @version      3.0
// @description  Command center, global navigation, indexing, and quality-of-life tools for Moodle sites
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    // Configuration variables
    // Change the values in this CONFIG object to your desired settings.
    // Do not modify anything else in this script.
    const CONFIG = {
        targetSite: "online.uom.lk", // Change this to your Moodle site domain
        shortcut: { ctrl: true, shift: true, key: "k" }, // Open command center
        darkModeShortcut: { ctrl: true, shift: true, key: "l" }, // Toggle dark mode
        maxResults: 24,
        cacheHours: 12,
        fullIndexBatchSize: 4,
        fuzzySearch: true
    };

    // DO NOT TOUCH BELOW THIS LINE UNLESS YOU KNOW WHAT YOU ARE DOING

    if (window.location.hostname !== CONFIG.targetSite) return;

    const STORAGE_KEY = `moodle-quick-open:${window.location.origin}:v3`;
    const CACHE_MS = CONFIG.cacheHours * 60 * 60 * 1000;
    const COURSE_PAGES = ["/my/", "/my/courses.php", "/course/index.php?mycourses=1"];
    const COURSE_URL_PATTERN = /\/course\/view\.php(?:\?|$)/;
    const ACTIVITY_URL_PATTERN = /\/mod\/[^/]+\/view\.php(?:\?|$)/;
    const RECENT_URL_PATTERN = /\/course\/recent\.php(?:\?|$)/;
    const FILTERS = [
        { id: "all", label: "All", icon: "sparkles" },
        { id: "course", label: "Courses", icon: "graduationCap" },
        { id: "module", label: "Activities", icon: "fileText" },
        { id: "current", label: "Current Course", icon: "mapPinned" },
        { id: "section", label: "Sections", icon: "layers" },
        { id: "recent", label: "Recent", icon: "clock" },
        { id: "command", label: "Commands", icon: "terminal" }
    ];
    const TYPE_THEME = {
        all: { bg: "#3f3f46", border: "#71717a", text: "#fafafa", icon: "#e4e4e7" },
        course: { bg: "#064e3b", border: "#10b981", text: "#d1fae5", icon: "#34d399" },
        module: { bg: "#78350f", border: "#f59e0b", text: "#fef3c7", icon: "#fbbf24" },
        section: { bg: "#581c87", border: "#a855f7", text: "#f3e8ff", icon: "#c084fc" },
        recent: { bg: "#7f1d1d", border: "#ef4444", text: "#fee2e2", icon: "#f87171" },
        command: { bg: "#312e81", border: "#818cf8", text: "#e0e7ff", icon: "#a5b4fc" },
        current: { bg: "#164e63", border: "#06b6d4", text: "#cffafe", icon: "#22d3ee" }
    };

    let overlay = null;
    let styleNode = null;
    let darkStyleNode = null;
    let refreshPromise = null;
    let state = readCache();
    let dataVersion = 0;
    let searchCacheVersion = -1;
    let searchCache = null;
    let renderTimer = null;
    let paletteState = {
        selected: 0,
        filter: "all",
        query: "",
        filtered: []
    };
    let indexStatus = { active: false, indexed: 0, total: 0, label: "" };

    function defaultState() {
        return {
            courses: [],
            modulesByCourseId: {},
            recentItems: [],
            fullIndexUpdatedAt: 0,
            updatedAt: 0,
            prefs: {
                darkMode: false,
                compactResults: false,
                focusMode: false,
                compactCourse: false
            }
        };
    }

    function readCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            return {
                ...defaultState(),
                ...cached,
                courses: Array.isArray(cached.courses) ? cached.courses : [],
                modulesByCourseId: cached.modulesByCourseId || {},
                recentItems: Array.isArray(cached.recentItems) ? cached.recentItems : [],
                prefs: { ...defaultState().prefs, ...(cached.prefs || {}) }
            };
        } catch (_) {
            return defaultState();
        }
    }

    function writeCache() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) {
            // Strict browser privacy modes can reject localStorage writes.
        }
    }

    function markDataChanged() {
        dataVersion += 1;
        searchCache = null;
        searchCacheVersion = -1;
    }

    function normalizeSpace(text) {
        return (text || "").replace(/\s+/g, " ").trim();
    }

    function normalizeUrl(url, preserveHash = false) {
        try {
            const parsed = new URL(url, window.location.origin);
            if (!preserveHash) parsed.hash = "";
            return parsed.href;
        } catch (_) {
            return "";
        }
    }

    function getCourseId(url) {
        try {
            return new URL(url, window.location.origin).searchParams.get("id") || "";
        } catch (_) {
            return "";
        }
    }

    function getActivityId(url) {
        try {
            return new URL(url, window.location.origin).searchParams.get("id") || "";
        } catch (_) {
            return "";
        }
    }

    function courseUrlForId(id) {
        return id ? `${window.location.origin}/course/view.php?id=${encodeURIComponent(id)}` : "";
    }

    function cleanCourseTitle(title) {
        return normalizeSpace(title)
            .replace(/^Course:\s*/i, "")
            .replace(/\s*\(opens in new window\)\s*$/i, "")
            .replace(/\s*Course image\s*/i, " ")
            .trim();
    }

    function courseTitleQuality(title) {
        const clean = cleanCourseTitle(title);
        let score = Math.min(clean.length, 120);
        if (/\s-\s/.test(clean)) score += 80;
        if (/[A-Za-z]{4,}/.test(clean.replace(/In\d{2}-S\d+-[A-Z]+\d+/i, ""))) score += 50;
        if (/^\s*In\d{2}-S\d+-[A-Z]+\d+\s*\(\d+\)\s*$/i.test(clean)) score -= 90;
        if (/^\d+$/.test(clean)) score -= 200;
        return score;
    }

    function bestCourseTitle(currentTitle, nextTitle) {
        const current = cleanCourseTitle(currentTitle);
        const next = cleanCourseTitle(nextTitle);
        if (!current) return next;
        if (!next) return current;
        return courseTitleQuality(next) > courseTitleQuality(current) ? next : current;
    }

    function uniqueBy(items, keyFn) {
        const seen = new Set();
        return items.filter(item => {
            const key = keyFn(item);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function courseTitle(courseId) {
        return searchMetadata().courseTitleById.get(courseId) || "";
    }

    function courseTitleFromState(courseId) {
        return state.courses.find(course => course.id === courseId)?.title || "";
    }

    function semesterInfo(text) {
        const match = normalizeSpace(text).match(/\bIn(\d{2})-S(\d+)\b/i);
        if (!match) return { intake: 0, semester: 0, rank: 0, label: "" };
        const intake = Number(match[1]);
        const semester = Number(match[2]);
        return {
            intake,
            semester,
            rank: intake * 10 + semester,
            label: `In${match[1]}-S${semester}`
        };
    }

    function itemSemesterRank(item) {
        if (item.courseId && searchMetadata().courseRankById.has(item.courseId)) {
            return searchMetadata().courseRankById.get(item.courseId);
        }
        const source = [item.title, item.subtitle, item.courseId ? courseTitle(item.courseId) : ""].filter(Boolean).join(" ");
        return semesterInfo(source).rank;
    }

    function semesterBoost(item) {
        const rank = itemSemesterRank(item);
        if (!rank) return 0;
        const maxRank = searchMetadata().maxSemesterRank || rank;
        return Math.max(0, 24 - (maxRank - rank) * 4);
    }

    function searchMetadata() {
        if (searchCache && searchCacheVersion === dataVersion) return searchCache.meta;
        buildSearchCache();
        return searchCache.meta;
    }

    function allModules() {
        return Object.values(state.modulesByCourseId).flat();
    }

    const ICONS = {
        refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
        x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        moon: '<path d="M12 3a6 6 0 0 0 9 7.4A9 9 0 1 1 12 3Z"/>',
        graduationCap: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/><path d="M22 10v6"/>',
        fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
        layers: '<path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
        sparkles: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="M5 3v4"/><path d="M3 5h4"/><path d="M19 17v4"/><path d="M17 19h4"/>',
        mapPinned: '<path d="M18 8c0 4-6 10-6 10S6 12 6 8a6 6 0 1 1 12 0Z"/><circle cx="12" cy="8" r="2"/><path d="M8.8 16.5 4 18l8 3 8-3-4.8-1.5"/>',
        layoutDashboard: '<path d="M3 3h8v8H3Z"/><path d="M13 3h8v5h-8Z"/><path d="M13 10h8v11h-8Z"/><path d="M3 13h8v8H3Z"/>',
        home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
        listRestart: '<path d="M21 6H3"/><path d="M7 12H3"/><path d="M7 18H3"/><path d="M11 12a5 5 0 1 0 2-4"/><path d="M11 5v3h3"/>',
        panelTop: '<path d="M3 5h18v14H3Z"/><path d="M3 9h18"/>'
    };

    function iconSvg(name, className = "mqo-svg") {
        const body = ICONS[name] || ICONS.sparkles;
        return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    }

    function themeForType(type) {
        return TYPE_THEME[type] || TYPE_THEME.module;
    }

    function styleVars(theme) {
        return `--mqo-type-bg:${theme.bg};--mqo-type-border:${theme.border};--mqo-type-text:${theme.text};--mqo-type-icon:${theme.icon};`;
    }

    function extractCourses(root) {
        const links = [...root.querySelectorAll("a[href*='/course/view.php']")];
        const courses = links.map(link => {
            const rawUrl = link.href || link.getAttribute("href");
            const id = getCourseId(rawUrl);
            const titleCandidates = [
                link.textContent,
                link.getAttribute("aria-label"),
                link.getAttribute("title"),
                link.querySelector("span")?.textContent,
                link.querySelector("img")?.getAttribute("alt")
            ].map(cleanCourseTitle).filter(Boolean);
            const title = titleCandidates.sort((a, b) => courseTitleQuality(b) - courseTitleQuality(a))[0] || "";

            return { id, title, url: courseUrlForId(id), type: "course" };
        }).filter(course => (
            course.id &&
            course.title &&
            !/^view course$/i.test(course.title) &&
            COURSE_URL_PATTERN.test(course.url)
        )).sort((a, b) => courseTitleQuality(b.title) - courseTitleQuality(a.title));

        return uniqueBy(courses, course => course.id);
    }

    function courseFromPage(course, root) {
        const heading = [
            root.querySelector(".page-header-headings h1")?.textContent,
            root.querySelector("h1")?.textContent,
            root.querySelector("title")?.textContent
        ].map(cleanCourseTitle).filter(Boolean).sort((a, b) => courseTitleQuality(b) - courseTitleQuality(a))[0];

        return heading ? { ...course, title: heading } : course;
    }

    function extractModules(root, courseId) {
        const activityLinks = [...root.querySelectorAll("a[href*='/mod/'][href*='/view.php']")];
        const sectionLinks = [...root.querySelectorAll(`a[href*='/course/view.php?id=${courseId}#section-'], a[href*='course/view.php?id=${courseId}#section-']`)];

        const activities = activityLinks.map(link => {
            const url = normalizeUrl(link.href || link.getAttribute("href"));
            const title = normalizeSpace(
                link.querySelector(".instancename")?.textContent ||
                link.querySelector(".aalink")?.textContent ||
                link.getAttribute("aria-label") ||
                link.title ||
                link.textContent
            ).replace(/\s*(File|Forum|Assignment|Quiz|URL|Page|Book|Folder|Label)\s*$/i, "");

            return {
                id: getActivityId(url),
                courseId,
                title,
                subtitle: activityTypeFromUrl(url),
                url,
                type: "module"
            };
        });

        const sections = sectionLinks.map(link => {
            const url = normalizeUrl(link.href || link.getAttribute("href"), true);
            const title = normalizeSpace(link.textContent || link.getAttribute("aria-label"));
            return {
                id: `${courseId}:${new URL(url).hash}`,
                courseId,
                title,
                subtitle: "Course section",
                url,
                type: "section"
            };
        });

        return uniqueBy([...activities, ...sections].filter(item => (
            item.id &&
            item.title &&
            !/^view$/i.test(item.title) &&
            (ACTIVITY_URL_PATTERN.test(item.url) || item.type === "section")
        )), item => `${item.type}:${item.id}`);
    }

    function extractRecentItems(root) {
        const recentRoots = [
            ...root.querySelectorAll(".block_recent_activity, [data-block='recentlyaccessedcourses'], [data-region='recentlyaccesseditems-view']")
        ];
        const searchRoots = recentRoots.length ? recentRoots : [root];

        const links = searchRoots.flatMap(container => [...container.querySelectorAll("a[href]")]);
        return uniqueBy(links.map(link => {
            const url = normalizeUrl(link.href || link.getAttribute("href"), true);
            const title = normalizeSpace(link.textContent || link.getAttribute("aria-label") || link.title);
            const courseId = getCourseId(url) || currentCourseFromPage()?.id || "";

            return {
                id: url,
                courseId,
                title,
                subtitle: courseTitleFromState(courseId) || "Recent activity",
                url,
                type: "recent"
            };
        }).filter(item => (
            item.title &&
            item.url.startsWith(window.location.origin) &&
            !item.url.includes("/login/") &&
            (COURSE_URL_PATTERN.test(item.url) || ACTIVITY_URL_PATTERN.test(item.url) || RECENT_URL_PATTERN.test(item.url))
        )), item => item.url).slice(0, 80);
    }

    function activityTypeFromUrl(url) {
        try {
            const match = new URL(url, window.location.origin).pathname.match(/\/mod\/([^/]+)\//);
            if (!match) return "Activity";
            return match[1].replace(/^\w/, char => char.toUpperCase());
        } catch (_) {
            return "Activity";
        }
    }

    function currentCourseFromPage() {
        if (COURSE_URL_PATTERN.test(window.location.href)) {
            const id = getCourseId(window.location.href);
            if (id) return { id, url: courseUrlForId(id) };
        }

        const breadcrumbCourse = [...document.querySelectorAll(".breadcrumb a[href*='/course/view.php'], nav a[href*='/course/view.php']")]
            .map(link => {
                const id = getCourseId(link.href);
                return { id, url: courseUrlForId(id) };
            })
            .filter(course => course.id)
            .pop();

        return breadcrumbCourse || null;
    }

    function mergeCourses(courses) {
        const byId = new Map(state.courses.map(course => [course.id, course]));
        courses.forEach(course => {
            const previous = byId.get(course.id) || {};
            byId.set(course.id, {
                ...previous,
                ...course,
                title: bestCourseTitle(previous.title, course.title),
                url: course.url || previous.url
            });
        });
        state.courses = [...byId.values()]
            .filter(course => course.id && course.title && course.url)
            .sort((a, b) => a.title.localeCompare(b.title));
        state.updatedAt = Date.now();
        markDataChanged();
        writeCache();
    }

    function mergeModules(courseId, modules, replace = true) {
        if (!courseId) return;
        state.modulesByCourseId[courseId] = uniqueBy([
            ...(replace ? [] : state.modulesByCourseId[courseId] || []),
            ...modules
        ], item => `${item.type}:${item.id}`).sort((a, b) => a.title.localeCompare(b.title));
        state.updatedAt = Date.now();
        markDataChanged();
        writeCache();
    }

    function mergeRecent(items) {
        state.recentItems = uniqueBy([...items, ...state.recentItems], item => item.url).slice(0, 100);
        state.updatedAt = Date.now();
        markDataChanged();
        writeCache();
    }

    async function fetchDocument(pathOrUrl) {
        const response = await fetch(new URL(pathOrUrl, window.location.origin).href, {
            credentials: "include",
            cache: "no-store"
        });
        if (!response.ok) throw new Error(`Failed to fetch ${pathOrUrl}: ${response.status}`);
        const html = await response.text();
        return new DOMParser().parseFromString(html, "text/html");
    }

    async function refreshCourses(options = {}) {
        if (refreshPromise) return refreshPromise;
        const { full = false, onProgress = null, force = false } = options;

        refreshPromise = (async () => {
            indexStatus = { active: true, indexed: 0, total: full ? state.courses.length || 1 : 1, label: "Discovering courses" };
            onProgress?.();

            mergeCourses(extractCourses(document));
            mergeRecent(extractRecentItems(document));

            const documents = await Promise.allSettled(COURSE_PAGES.map(fetchDocument));
            documents.forEach(result => {
                if (result.status !== "fulfilled") return;
                mergeCourses(extractCourses(result.value));
                mergeRecent(extractRecentItems(result.value));
            });

            const currentCourse = currentCourseFromPage();
            if (currentCourse) {
                await refreshModulesForCourse(currentCourse);
            }

            if (full || force) {
                await refreshAllCourseModules(onProgress);
            }
        })().finally(() => {
            refreshPromise = null;
            indexStatus = { active: false, indexed: 0, total: 0, label: "" };
            onProgress?.();
        });

        return refreshPromise;
    }

    async function refreshModulesForCourse(course) {
        mergeModules(course.id, extractModules(document, course.id), false);

        try {
            const coursePage = await fetchDocument(course.url);
            mergeCourses([courseFromPage(course, coursePage)]);
            mergeCourses(extractCourses(coursePage));
            mergeRecent(extractRecentItems(coursePage));
            mergeModules(course.id, extractModules(coursePage, course.id), true);
        } catch (_) {
            // Keep current-page discoveries if the course page fetch is blocked.
        }
    }

    async function refreshAllCourseModules(onProgress) {
        const courses = prioritizeCoursesForRefresh();
        indexStatus = { active: true, indexed: 0, total: courses.length, label: "Indexing course tree" };
        onProgress?.();

        for (let index = 0; index < courses.length; index += CONFIG.fullIndexBatchSize) {
            const batch = courses.slice(index, index + CONFIG.fullIndexBatchSize);
            const pages = await Promise.allSettled(batch.map(async course => {
                const page = await fetchDocument(course.url);
                return { course, page };
            }));

            pages.forEach(result => {
                indexStatus.indexed += 1;
                if (result.status !== "fulfilled") return;

                const { course, page } = result.value;
                mergeCourses([courseFromPage(course, page)]);
                mergeCourses(extractCourses(page));
                mergeRecent(extractRecentItems(page));
                mergeModules(course.id, extractModules(page, course.id), true);
            });

            onProgress?.();
        }

        state.fullIndexUpdatedAt = Date.now();
        state.updatedAt = Date.now();
        writeCache();
    }

    function prioritizeCoursesForRefresh() {
        const recentCourseIds = new Set(state.recentItems.map(item => item.courseId).filter(Boolean));
        return [...state.courses].sort((a, b) => {
            const aRecent = recentCourseIds.has(a.id) ? 1 : 0;
            const bRecent = recentCourseIds.has(b.id) ? 1 : 0;
            return bRecent - aRecent || a.title.localeCompare(b.title);
        });
    }

    function currentModules() {
        const course = currentCourseFromPage();
        if (!course) return [];
        return state.modulesByCourseId[course.id] || [];
    }

    function parseMode(rawQuery) {
        const match = rawQuery.match(/^\s*(course|courses|module|modules|activity|activities|current|here|section|sections|recent|commands?|actions?)\s*:\s*(.*)$/i);
        if (!match) return { mode: paletteState.filter, query: rawQuery.trim() };
        const mode = match[1].toLowerCase();
        return {
            mode: mode.startsWith("course") ? "course" :
                mode.startsWith("current") || mode.startsWith("here") ? "current" :
                    mode.startsWith("section") ? "section" :
                        mode.startsWith("recent") ? "recent" :
                            mode.startsWith("command") || mode.startsWith("action") ? "command" : "module",
            query: match[2].trim()
        };
    }

    function scoreText(text, query) {
        const haystack = normalizeSpace(text).toLowerCase();
        return scorePreparedText(haystack, normalizeSpace(query).toLowerCase());
    }

    function scorePreparedText(haystack, needle) {
        if (!needle) return 1;
        if (haystack === needle) return 140;
        if (haystack.startsWith(needle)) return 100;
        if (haystack.includes(needle)) return 70;

        const parts = needle.split(/\s+/).filter(Boolean);
        if (parts.length && parts.every(part => haystack.includes(part))) return 48;
        if (!CONFIG.fuzzySearch) return 0;

        let cursor = 0;
        let score = 0;
        for (const char of needle) {
            cursor = haystack.indexOf(char, cursor);
            if (cursor === -1) return 0;
            score += 1;
            cursor += 1;
        }
        return Math.max(8, score);
    }

    function itemSearchText(item) {
        return [
            item.title,
            item.subtitle,
            item.type,
            item.courseId ? courseTitle(item.courseId) : ""
        ].filter(Boolean).join(" ");
    }

    function buildSearchCache() {
        const courseTitleById = new Map(state.courses.map(course => [course.id, course.title]));
        const courseRankById = new Map(state.courses.map(course => [course.id, semesterInfo(course.title).rank]));
        const ranks = [...courseRankById.values()].filter(Boolean);
        const maxSemesterRank = ranks.length ? Math.max(...ranks) : 0;
        const currentCourse = currentCourseFromPage();

        const meta = { courseTitleById, courseRankById, maxSemesterRank, currentCourseId: currentCourse?.id || "" };

        function enrich(command) {
            const searchText = normalizeSpace([
                command.title,
                command.subtitle,
                command.type,
                command.courseId ? courseTitleById.get(command.courseId) : ""
            ].filter(Boolean).join(" ")).toLowerCase();
            const rank = command.courseId && courseRankById.has(command.courseId)
                ? courseRankById.get(command.courseId)
                : semesterInfo(`${command.title} ${command.subtitle}`).rank;
            const boost = rank ? Math.max(0, 24 - (maxSemesterRank - rank) * 4) : 0;
            return { ...command, searchText, semesterRank: rank || 0, semesterBoost: boost };
        }

        const courses = state.courses.map(course => {
            const info = semesterInfo(course.title);
            return enrich({
                id: `course:${course.id}`,
                title: course.title,
                subtitle: info.label ? `Course - ${info.label}` : "Course",
                url: course.url,
                type: "course",
                icon: "graduationCap",
                action: () => navigate(course.url)
            });
        });

        const modules = allModules().map(item => enrich({
            ...item,
            id: `${item.type}:${item.id}`,
            subtitle: `${courseTitleById.get(item.courseId) || ""} - ${item.subtitle}`,
            icon: item.type === "section" ? "layers" : "fileText",
            action: () => navigate(item.url)
        }));

        const recent = state.recentItems.map(item => enrich({
            ...item,
            id: `recent:${item.id}`,
            subtitle: `${courseTitleById.get(item.courseId) || item.subtitle} - Recent`,
            icon: "clock",
            action: () => navigate(item.url)
        }));

        const commands = siteCommands().map(command => enrich({
            ...command,
            id: `command:${command.id}`,
            type: "command",
            icon: command.icon || "terminal"
        }));

        searchCache = {
            meta,
            courses,
            modules,
            recent,
            commands
        };
        searchCacheVersion = dataVersion;
        return searchCache;
    }

    function buildCommands(rawQuery) {
        const { mode, query } = parseMode(rawQuery);
        const preparedQuery = normalizeSpace(query).toLowerCase();
        const cache = buildSearchCache();
        const commands = [];

        if (mode === "all" || mode === "course") commands.push(...cache.courses);

        if (mode === "all" || mode === "module" || mode === "section" || mode === "current") {
            commands.push(...cache.modules.filter(item => (
                (mode !== "section" || item.type === "section") &&
                (mode !== "current" || item.courseId === cache.meta.currentCourseId)
            )));
        }

        if (mode === "all" || mode === "recent") commands.push(...cache.recent);
        if (mode === "all" || mode === "command") commands.push(...cache.commands);

        return commands
            .map(command => ({ ...command, score: scorePreparedText(command.searchText, preparedQuery) + command.semesterBoost }))
            .filter(command => command.score > 0)
            .sort((a, b) => b.score - a.score || b.semesterRank - a.semesterRank || a.title.localeCompare(b.title))
            .slice(0, CONFIG.maxResults);
    }

    function siteCommands() {
        return [
            {
                id: "toggle-dark-mode",
                title: state.prefs.darkMode ? "Disable dark mode" : "Enable dark mode",
                subtitle: "Site appearance",
                icon: "moon",
                action: () => {
                    setDarkMode(!state.prefs.darkMode);
                    renderPalette();
                }
            },
            {
                id: "refresh-index",
                title: "Refresh full Moodle index",
                subtitle: "Re-scan all discovered courses",
                icon: "refresh",
                action: () => refreshCourses({ full: true, force: true, onProgress: renderPalette }).then(renderPalette).catch(renderPalette)
            },
            {
                id: "open-dashboard",
                title: "Open Moodle dashboard",
                subtitle: "/my/",
                icon: "layoutDashboard",
                action: () => navigate(`${window.location.origin}/my/`)
            },
            {
                id: "open-current-course",
                title: "Open current course home",
                subtitle: currentCourseFromPage() ? courseTitleFromState(currentCourseFromPage().id) || "Course home" : "Only available inside a course",
                icon: "home",
                action: () => {
                    const current = currentCourseFromPage();
                    if (current) navigate(current.url);
                }
            },
            {
                id: "open-recent-activity",
                title: "Open current course recent activity",
                subtitle: currentCourseFromPage() ? "Course recent activity report" : "Only available inside a course",
                icon: "clock",
                action: () => {
                    const current = currentCourseFromPage();
                    if (current) navigate(`${window.location.origin}/course/recent.php?id=${encodeURIComponent(current.id)}`);
                }
            },
            {
                id: "download-lecture-notes",
                title: "Download lecture notes from current course",
                subtitle: currentCourseFromPage() ? "Smart filter for PDF, PPT, and PPTX lecture resources" : "Only available inside a course",
                icon: "download",
                action: () => downloadLectureNotesFromCurrentCourse().catch(error => {
                    showToast(`Could not download lecture notes: ${error.message}`);
                })
            },
            {
                id: "toggle-compact-results",
                title: state.prefs.compactResults ? "Use comfortable result spacing" : "Use compact result spacing",
                subtitle: "Command center layout",
                icon: "panelTop",
                action: () => {
                    state.prefs.compactResults = !state.prefs.compactResults;
                    writeCache();
                    renderPalette();
                }
            },
            {
                id: "toggle-focus-mode",
                title: state.prefs.focusMode ? "Disable Moodle focus mode" : "Enable Moodle focus mode",
                subtitle: "Hide Moodle drawers and side blocks for reading",
                icon: "panelTop",
                action: () => {
                    setFocusMode(!state.prefs.focusMode);
                    renderPalette();
                }
            },
            {
                id: "toggle-compact-course",
                title: state.prefs.compactCourse ? "Use comfortable course layout" : "Use compact course layout",
                subtitle: "Tighten Moodle activity cards and course sections",
                icon: "listRestart",
                action: () => {
                    setCompactCourse(!state.prefs.compactCourse);
                    renderPalette();
                }
            },
            {
                id: "clear-cache",
                title: "Clear navigation cache",
                subtitle: "Forget indexed courses and rebuild",
                icon: "trash",
                action: () => {
                    const prefs = state.prefs;
                    state = { ...defaultState(), prefs };
                    markDataChanged();
                    writeCache();
                    refreshCourses({ full: true, force: true, onProgress: renderPalette }).then(renderPalette).catch(renderPalette);
                }
            }
        ];
    }

    function navigate(url) {
        window.location.href = url;
    }

    function lectureNoteScore(text, url) {
        const haystack = normalizeSpace(`${text} ${url}`).toLowerCase();
        const extensionScore = /\.(pdf|pptx?|odp)(?:[?#]|$)/i.test(url) ? 28 : 0;
        const resourceScore = /\/mod\/resource\/view\.php/i.test(url) ? 14 : 0;
        if (!extensionScore && !resourceScore) return 0;

        const positives = [
            [/\blecture\s*\d*\b|\blec\s*\d+\b|\bl\d+\b/i, 36],
            [/\bslides?\b|\bslide\s*deck\b|\bpptx?\b|\bpresentation\b/i, 34],
            [/\bnotes?\b|\bhandout\b|\breading\b|\bmaterial(s)?\b|\bchapter\b/i, 26],
            [/\bweek\s*\d+\b|\bunit\s*\d+\b|\btopic\s*\d+\b/i, 18],
            [/\bcourse\s*(content|material)\b/i, 16]
        ];
        const negatives = [
            [/\bassignment\b|\bsubmit\b|\bsubmission\b|\bdue\b/i, 55],
            [/\bquiz\b|\btest\b|\bexam\b|\bmidterm\b|\bfinal\b/i, 45],
            [/\btutorial\b|\btute\b|\blab\b|\bpractical\b|\bworksheet\b|\bexercise\b/i, 28],
            [/\banswer(s)?\b|\bsolution(s)?\b|\bmarking\b|\brubric\b|\bfeedback\b/i, 35],
            [/\boutline\b|\bsyllabus\b|\bschedule\b|\btimetable\b/i, 24],
            [/\bforum\b|\bzoom\b|\battendance\b|\brecording\b/i, 30]
        ];

        const positiveScore = positives.reduce((sum, [pattern, score]) => sum + (pattern.test(haystack) ? score : 0), 0);
        const negativeScore = negatives.reduce((sum, [pattern, score]) => sum + (pattern.test(haystack) ? score : 0), 0);
        return extensionScore + resourceScore + positiveScore - negativeScore;
    }

    function collectLectureNoteLinks(root) {
        const links = [...root.querySelectorAll("a[href]")];
        const candidates = links.map(link => {
            const url = normalizeUrl(link.href || link.getAttribute("href"), true);
            const activity = link.closest(".activity-item, .activity, li, .course-content-item-content, .section-item");
            const section = link.closest(".section-item");
            const title = normalizeSpace(
                link.querySelector(".instancename")?.textContent ||
                link.textContent ||
                link.getAttribute("aria-label") ||
                link.title
            );
            const context = normalizeSpace([
                title,
                activity?.getAttribute("data-activityname"),
                activity?.textContent,
                section?.querySelector(".sectionname")?.textContent
            ].filter(Boolean).join(" "));
            const score = lectureNoteScore(context, url);
            return { title: title || context || url, context, url, score };
        }).filter(item => (
            item.url.startsWith(window.location.origin) &&
            item.score >= 48
        )).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

        return uniqueBy(candidates, item => item.url);
    }

    function filenameFromLectureCandidate(candidate, index) {
        const extension = new URL(candidate.url, window.location.origin).pathname.match(/\.(pdf|pptx?|odp)$/i)?.[0] || "";
        const base = normalizeSpace(candidate.title)
            .replace(/\b(File|Powerpoint|PDF|Presentation)\b/gi, "")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120) || `lecture-note-${index + 1}`;
        return extension && !base.toLowerCase().endsWith(extension.toLowerCase()) ? `${base}${extension}` : base;
    }

    function triggerDownload(url, filename) {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.rel = "noopener";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function showToast(message) {
        const existing = document.querySelector(".mqo-toast");
        existing?.remove();

        const toast = document.createElement("div");
        toast.className = "mqo-toast";
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4200);
    }

    async function downloadLectureNotesFromCurrentCourse() {
        const current = currentCourseFromPage();
        if (!current) {
            showToast("Open a Moodle course first, then run this command.");
            return;
        }

        let page = document;
        if (!COURSE_URL_PATTERN.test(window.location.href)) {
            page = await fetchDocument(current.url);
        }

        const notes = collectLectureNoteLinks(page);
        if (!notes.length) {
            showToast("No high-confidence lecture notes found in this course.");
            return;
        }

        closePalette();
        showToast(`Downloading ${notes.length} likely lecture note file${notes.length === 1 ? "" : "s"}...`);
        notes.forEach((note, index) => {
            setTimeout(() => triggerDownload(note.url, filenameFromLectureCandidate(note, index)), index * 450);
        });
    }

    function installBaseStyles() {
        if (styleNode) return;
        styleNode = document.createElement("style");
        styleNode.textContent = `
            .mqo-overlay {
                position: fixed;
                inset: 0;
                z-index: 999999;
                display: flex;
                align-items: flex-start;
                justify-content: center;
                padding: 54px 12px 0;
                background: rgba(3, 7, 18, 0.52);
                color: #111827;
                font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            }
            .mqo-box {
                width: min(900px, 96vw);
                overflow: hidden;
                border: 1px solid rgba(148, 163, 184, 0.45);
                border-radius: 10px;
                background: #f8fafc;
                box-shadow: 0 28px 80px rgba(0, 0, 0, 0.38);
            }
            .mqo-top {
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 10px;
                align-items: center;
                padding: 12px;
                background: #ffffff;
                border-bottom: 1px solid var(--mqo-border) ;
            }
            .mqo-input {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid transparent;
                outline: none;
                border-radius: 8px;
                padding: 13px 14px;
                background: #f1f5f9;
                color: #111827;
                font-size: 17px;
            }
            .mqo-input:focus {
                border-color: #2563eb;
                background: #ffffff;
            }
            .mqo-actions {
                display: flex;
                gap: 6px;
            }
            .mqo-icon-button {
                display: inline-grid;
                place-items: center;
                width: 38px;
                height: 38px;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                background: #ffffff;
                color: #111827;
                cursor: pointer;
                font-size: 15px;
                font-weight: 700;
            }
            .mqo-svg {
                width: 17px;
                height: 17px;
                display: block;
            }
            .mqo-icon-button:hover {
                background: #eff6ff;
                border-color: #93c5fd;
            }
            .mqo-filters {
                display: flex;
                gap: 6px;
                overflow-x: auto;
                padding: 9px 12px;
                background: #f8fafc;
                border-bottom: 1px solid var(--mqo-border) ;
            }
            .mqo-filter {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                border: 1px solid #d1d5db;
                border-radius: 999px;
                background: #ffffff;
                color: #374151;
                cursor: pointer;
                padding: 6px 11px;
                font-size: 12px;
                white-space: nowrap;
            }
            .mqo-filter-icon {
                width: 14px;
                height: 14px;
                color: var(--mqo-type-icon);
            }
            .mqo-filter-active {
                border-color: var(--mqo-type-border);
                background: color-mix(in srgb, var(--mqo-type-bg) 14%, white);
                color: var(--mqo-type-bg);
                font-weight: 700;
            }
            .mqo-results {
                max-height: min(540px, 64vh);
                overflow-y: auto;
                background: #ffffff;
            }
            .mqo-empty {
                padding: 18px;
                color: #64748b;
                font-size: 14px;
            }
            .mqo-item {
                position: relative;
                display: grid;
                grid-template-columns: 34px 1fr auto;
                gap: 12px;
                align-items: center;
                padding: var(--mqo-result-padding, 11px 14px);
                border-bottom: 1px solid #f1f5f9;
                cursor: pointer;
            }
            .mqo-item::before {
                content: "";
                position: absolute;
                inset: 8px auto 8px 0;
                width: 3px;
                border-radius: 999px;
                background: var(--mqo-type-border);
                opacity: 0.65;
            }
            .mqo-item:hover,
            .mqo-item-active {
                background: #eef3ff;
            }
            .mqo-glyph {
                display: grid;
                width: 30px;
                height: 30px;
                place-items: center;
                border-radius: 8px;
                background: color-mix(in srgb, var(--mqo-type-bg) 14%, white);
                color: var(--mqo-type-bg);
                border: 1px solid color-mix(in srgb, var(--mqo-type-border) 36%, white);
                font-size: 12px;
                font-weight: 800;
            }
            .mqo-title {
                color: #111827;
                font-size: 14px;
                line-height: 1.35;
            }
            .mqo-subtitle {
                margin-top: 2px;
                color: #64748b;
                font-size: 12px;
                line-height: 1.35;
            }
            .mqo-badge {
                border-radius: 999px;
                background: color-mix(in srgb, var(--mqo-type-bg) 10%, white);
                color: var(--mqo-type-bg);
                border: 1px solid color-mix(in srgb, var(--mqo-type-border) 28%, white);
                padding: 4px 8px;
                font-size: 11px;
                text-transform: capitalize;
            }
            .mqo-footer {
                display: flex;
                justify-content: space-between;
                gap: 12px;
                padding: 9px 13px;
                background: #f8fafc;
                border-top: 1px solid var(--mqo-border) ;
                color: #64748b;
                font-size: 12px;
            }
            .mqo-shortcuts {
                white-space: nowrap;
            }
            .mqo-compact .mqo-item {
                --mqo-result-padding: 7px 13px;
            }
            .mqo-compact .mqo-glyph {
                width: 26px;
                height: 26px;
            }
            .mqo-toast {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 1000000;
                max-width: min(420px, calc(100vw - 36px));
                padding: 12px 14px;
                border: 1px solid #d1d5db;
                border-radius: 10px;
                background: #ffffff;
                color: #111827;
                box-shadow: 0 16px 45px rgba(0, 0, 0, 0.22);
                font-size: 13px;
                line-height: 1.35;
            }
            @media (max-width: 640px) {
                .mqo-overlay {
                    padding-top: 18px;
                }
                .mqo-top {
                    grid-template-columns: 1fr;
                }
                .mqo-actions {
                    justify-content: flex-end;
                }
                .mqo-item {
                    grid-template-columns: 30px 1fr;
                }
                .mqo-badge {
                    display: none;
                }
                .mqo-shortcuts {
                    display: none;
                }
            }
        `;
        document.head.appendChild(styleNode);
    }

    function setDarkMode(enabled) {
        state.prefs.darkMode = enabled;
        writeCache();
        document.documentElement.dataset.mqoDark = enabled ? "true" : "false";
        installDarkStyles();
    }

    function setFocusMode(enabled) {
        state.prefs.focusMode = enabled;
        writeCache();
        document.documentElement.dataset.mqoFocus = enabled ? "true" : "false";
        installDarkStyles();
    }

    function setCompactCourse(enabled) {
        state.prefs.compactCourse = enabled;
        writeCache();
        document.documentElement.dataset.mqoCompactCourse = enabled ? "true" : "false";
        installDarkStyles();
    }

    function installDarkStyles() {
        if (darkStyleNode) return;
        darkStyleNode = document.createElement("style");
        darkStyleNode.textContent = `
            html[data-mqo-dark="true"] {
                --mqo-bg: #09090b;
                --mqo-surface: #18181b;
                --mqo-surface-2: #1f1f23;
                --mqo-surface-3: #27272a;
                --mqo-surface-hover: #2f2f34;
                --mqo-border: #3f3f46;
                --mqo-border-soft: #27272a;
                --mqo-border-strong: #52525b;
                --mqo-text: #f4f4f5;
                --mqo-muted: #a1a1aa;
                --mqo-link: #d4d4d8;
                --mqo-accent: #a1a1aa;
                --mqo-radius: 10px;
                color-scheme: dark;
                scrollbar-color: #52525b #18181b;
                scrollbar-width: thin;
            }
            html[data-mqo-dark="true"] *,
            html[data-mqo-dark="true"] *::before,
            html[data-mqo-dark="true"] *::after {
                box-shadow: none !important;
                outline-color: var(--mqo-accent) !important;
                scrollbar-color: #52525b #18181b;
                scrollbar-width: thin;
            }
            html[data-mqo-dark="true"] ::-webkit-scrollbar {
                width: 10px;
                height: 10px;
            }
            html[data-mqo-dark="true"] ::-webkit-scrollbar-track {
                background: #18181b;
            }
            html[data-mqo-dark="true"] ::-webkit-scrollbar-thumb {
                background: #52525b;
                border: 2px solid #18181b;
                border-radius: 999px;
            }
            html[data-mqo-dark="true"] ::-webkit-scrollbar-thumb:hover {
                background: #71717a;
            }
            html[data-mqo-dark="true"],
            html[data-mqo-dark="true"] body {
                background: var(--mqo-bg) !important;
                color: var(--mqo-text) !important;
                text-rendering: optimizeLegibility;
                -webkit-font-smoothing: antialiased;
            }
            html[data-mqo-dark="true"] .navbar,
            html[data-mqo-dark="true"] nav.navbar,
            html[data-mqo-dark="true"] .secondary-navigation {
                background: #111113 !important;
                border-color: var(--mqo-border) !important;
                backdrop-filter: blur(10px);
            }
            html[data-mqo-dark="true"] #page,
            html[data-mqo-dark="true"] #page-content,
            html[data-mqo-dark="true"] #region-main,
            html[data-mqo-dark="true"] [role="main"],
            html[data-mqo-dark="true"] .main-inner,
            html[data-mqo-dark="true"] .page-context-header,
            html[data-mqo-dark="true"] .secondary-navigation,
            html[data-mqo-dark="true"] .container,
            html[data-mqo-dark="true"] .container-fluid,
            html[data-mqo-dark="true"] .card,
            html[data-mqo-dark="true"] .card-body,
            html[data-mqo-dark="true"] .block,
            html[data-mqo-dark="true"] .box,
            html[data-mqo-dark="true"] .generalbox,
            html[data-mqo-dark="true"] .well,
            html[data-mqo-dark="true"] .jumbotron,
            html[data-mqo-dark="true"] .list-group,
            html[data-mqo-dark="true"] .list-group-item,
            html[data-mqo-dark="true"] .bg-white,
            html[data-mqo-dark="true"] .bg-light,
            html[data-mqo-dark="true"] .bg-gray,
            html[data-mqo-dark="true"] .bg-body,
            html[data-mqo-dark="true"] .bg-body-tertiary,
            html[data-mqo-dark="true"] [style*="background: white"],
            html[data-mqo-dark="true"] [style*="background:white"],
            html[data-mqo-dark="true"] [style*="background-color: white"],
            html[data-mqo-dark="true"] [style*="background-color:white"],
            html[data-mqo-dark="true"] [style*="background: #fff"],
            html[data-mqo-dark="true"] [style*="background-color: #fff"],
            html[data-mqo-dark="true"] .course-content,
            html[data-mqo-dark="true"] .section,
            html[data-mqo-dark="true"] .sectionname,
            html[data-mqo-dark="true"] .activity,
            html[data-mqo-dark="true"] .activity-item,
            html[data-mqo-dark="true"] .activityinstance,
            html[data-mqo-dark="true"] .section-item,
            html[data-mqo-dark="true"] .course-section-header,
            html[data-mqo-dark="true"] .course-content-item,
            html[data-mqo-dark="true"] .course-content-item-content,
            html[data-mqo-dark="true"] .description,
            html[data-mqo-dark="true"] .content,
            html[data-mqo-dark="true"] .summary,
            html[data-mqo-dark="true"] .preferences-container,
            html[data-mqo-dark="true"] .preferences-group,
            html[data-mqo-dark="true"] .node_category,
            html[data-mqo-dark="true"] .node_category ul,
            html[data-mqo-dark="true"] .node_category li,
            html[data-mqo-dark="true"] .navbar,
            html[data-mqo-dark="true"] .drawer,
            html[data-mqo-dark="true"] .dropdown-menu,
            html[data-mqo-dark="true"] .modal-content {
                background-color: var(--mqo-surface) !important;
                color: var(--mqo-text) !important;
                border-color: var(--mqo-border-soft) !important;
            }
            html[data-mqo-dark="true"] .card,
            html[data-mqo-dark="true"] .block,
            html[data-mqo-dark="true"] .box,
            html[data-mqo-dark="true"] .generalbox,
            html[data-mqo-dark="true"] .preferences-group,
            html[data-mqo-dark="true"] .node_category,
            html[data-mqo-dark="true"] .section-item {
                background-color: var(--mqo-surface-2) !important;
                border: 1px solid var(--mqo-border-soft) !important;
                border-radius: var(--mqo-radius) !important;
            }
            html[data-mqo-dark="true"] .section-item,
            html[data-mqo-dark="true"] .course-section-header,
            html[data-mqo-dark="true"] .course-content-item,
            html[data-mqo-dark="true"] .course-content-item-content,
            html[data-mqo-dark="true"] .focus-control {
                outline: none !important;
                box-shadow: none !important;
            }
            html[data-mqo-dark="true"] .section-item {
                border-color: #2a2a2f !important;
            }
            html[data-mqo-dark="true"] .course-section-header {
                border-bottom: 1px solid #27272a !important;
            }
            html[data-mqo-dark="true"] .activity-item,
            html[data-mqo-dark="true"] .list-group-item,
            html[data-mqo-dark="true"] .dropdown-item {
                border-radius: 8px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
            }
            html[data-mqo-dark="true"] .activity-item:hover,
            html[data-mqo-dark="true"] .list-group-item:hover,
            html[data-mqo-dark="true"] .dropdown-item:hover {
                background-color: var(--mqo-surface-hover) !important;
            }
            html[data-mqo-dark="true"] h1,
            html[data-mqo-dark="true"] h2,
            html[data-mqo-dark="true"] h3,
            html[data-mqo-dark="true"] h4,
            html[data-mqo-dark="true"] h5,
            html[data-mqo-dark="true"] h6,
            html[data-mqo-dark="true"] p,
            html[data-mqo-dark="true"] li,
            html[data-mqo-dark="true"] label,
            html[data-mqo-dark="true"] legend,
            html[data-mqo-dark="true"] .h1,
            html[data-mqo-dark="true"] .h2,
            html[data-mqo-dark="true"] .h3,
            html[data-mqo-dark="true"] .h4,
            html[data-mqo-dark="true"] .h5,
            html[data-mqo-dark="true"] .h6,
            html[data-mqo-dark="true"] .page-header-headings,
            html[data-mqo-dark="true"] .page-header-headings h1 {
                color: var(--mqo-text) !important;
                font-weight: 720 !important;
                letter-spacing: 0 !important;
            }
            html[data-mqo-dark="true"] h1 {
                font-size: clamp(1.55rem, 1.1rem + 1vw, 2.15rem) !important;
            }
            html[data-mqo-dark="true"] h2,
            html[data-mqo-dark="true"] h3 {
                font-weight: 680 !important;
            }
            html[data-mqo-dark="true"] a {
                color: var(--mqo-link) !important;
                text-decoration-color: rgba(143, 188, 255, 0.35) !important;
                text-underline-offset: 0.18em;
            }
            html[data-mqo-dark="true"] a:hover,
            html[data-mqo-dark="true"] a:focus {
                color: #fafafa !important;
            }
            html[data-mqo-dark="true"] .text-muted,
            html[data-mqo-dark="true"] .text-body-secondary,
            html[data-mqo-dark="true"] .text-secondary,
            html[data-mqo-dark="true"] .text-dark,
            html[data-mqo-dark="true"] .text-black,
            html[data-mqo-dark="true"] small,
            html[data-mqo-dark="true"] .dimmed,
            html[data-mqo-dark="true"] .availabilityinfo,
            html[data-mqo-dark="true"] .description .no-overflow,
            html[data-mqo-dark="true"] .summary {
                color: var(--mqo-muted) !important;
            }
            html[data-mqo-dark="true"] input,
            html[data-mqo-dark="true"] textarea,
            html[data-mqo-dark="true"] select,
            html[data-mqo-dark="true"] .form-control {
                background: #111113 !important;
                color: var(--mqo-text) !important;
                border-color: var(--mqo-border-strong) !important;
                border-radius: 8px !important;
            }
            html[data-mqo-dark="true"] input:focus,
            html[data-mqo-dark="true"] textarea:focus,
            html[data-mqo-dark="true"] select:focus,
            html[data-mqo-dark="true"] .form-control:focus,
            html[data-mqo-dark="true"] a:focus,
            html[data-mqo-dark="true"] button:focus,
            html[data-mqo-dark="true"] .btn:focus {
                outline: 2px solid rgba(161, 161, 170, 0.5) !important;
                outline-offset: 2px !important;
                box-shadow: 0 0 0 4px rgba(161, 161, 170, 0.1) !important;
            }
            html[data-mqo-dark="true"] .btn,
            html[data-mqo-dark="true"] button,
            html[data-mqo-dark="true"] .btn-secondary,
            html[data-mqo-dark="true"] .btn-light {
                background-color: var(--mqo-surface-3) !important;
                color: var(--mqo-text) !important;
                border-color: var(--mqo-border-strong) !important;
                border-radius: 8px !important;
            }
            html[data-mqo-dark="true"] .btn-primary {
                background-color: #3f3f46 !important;
                color: #ffffff !important;
                border-color: #71717a !important;
            }
            html[data-mqo-dark="true"] table,
            html[data-mqo-dark="true"] th,
            html[data-mqo-dark="true"] td {
                background-color: var(--mqo-surface) !important;
                color: var(--mqo-text) !important;
                border-color: var(--mqo-border) !important;
            }
            html[data-mqo-dark="true"] hr,
            html[data-mqo-dark="true"] .border,
            html[data-mqo-dark="true"] .border-top,
            html[data-mqo-dark="true"] .border-bottom,
            html[data-mqo-dark="true"] .border-left,
            html[data-mqo-dark="true"] .border-right {
                border-color: var(--mqo-border) !important;
            }
            html[data-mqo-dark="true"] hr {
                background-color: var(--mqo-border-soft) !important;
                border: 0 !important;
                height: 1px !important;
                opacity: 1 !important;
            }
            html[data-mqo-dark="true"] .badge,
            html[data-mqo-dark="true"] .rounded-pill,
            html[data-mqo-dark="true"] .activitybadge,
            html[data-mqo-dark="true"] .sectionbadges .badge,
            html[data-mqo-dark="true"] .badge-light,
            html[data-mqo-dark="true"] .badge-secondary,
            html[data-mqo-dark="true"] .tag,
            html[data-mqo-dark="true"] .label {
                background-color: #27272a !important;
                color: #d4d4d8 !important;
                border: 1px solid #3f3f46 !important;
            }
            html[data-mqo-dark="true"] img:not(.mqo-preserve-image),
            html[data-mqo-dark="true"] video,
            html[data-mqo-dark="true"] iframe {
                filter: brightness(0.92);
            }
            html[data-mqo-dark="true"] .mqo-overlay,
            html[data-mqo-dark="true"] .mqo-overlay * {
                filter: none !important;
            }
            html[data-mqo-dark="true"] .mqo-box {
                background: #18181b !important;
                color: var(--mqo-text) !important;
                border-color: var(--mqo-border) !important;
            }
            html[data-mqo-dark="true"] .mqo-top,
            html[data-mqo-dark="true"] .mqo-results,
            html[data-mqo-dark="true"] .mqo-icon-button {
                background: #18181b !important;
                color: var(--mqo-text) !important;
            }
            html[data-mqo-dark="true"] .mqo-filters,
            html[data-mqo-dark="true"] .mqo-footer {
                background: #111113 !important;
                color: var(--mqo-muted) !important;
            }
            html[data-mqo-dark="true"] .mqo-input {
                background: #111113 !important;
                color: var(--mqo-text) !important;
                border-color: var(--mqo-border) !important;
            }
            html[data-mqo-dark="true"] .mqo-input:focus {
                background: #18181b !important;
                border-color: var(--mqo-accent) !important;
            }
            html[data-mqo-dark="true"] .mqo-filter {
                background: #1f1f23 !important;
                color: var(--mqo-muted) !important;
                border-color: var(--mqo-border) !important;
            }
            html[data-mqo-dark="true"] .mqo-filter-icon {
                color: var(--mqo-type-icon) !important;
            }
            html[data-mqo-dark="true"] .mqo-filter-active {
                background: color-mix(in srgb, var(--mqo-type-bg) 42%, #18181b) !important;
                color: var(--mqo-type-text) !important;
                border-color: var(--mqo-type-border) !important;
            }
            html[data-mqo-dark="true"] .mqo-item {
                background: #18181b !important;
                color: var(--mqo-text) !important;
                border-bottom-color: #27272a !important;
            }
            html[data-mqo-dark="true"] .mqo-item:hover,
            html[data-mqo-dark="true"] .mqo-item-active {
                background: #27272a !important;
            }
            html[data-mqo-dark="true"] .mqo-title {
                color: var(--mqo-text) !important;
            }
            html[data-mqo-dark="true"] .mqo-subtitle,
            html[data-mqo-dark="true"] .mqo-badge {
                color: var(--mqo-muted) !important;
            }
            html[data-mqo-dark="true"] .mqo-badge {
                background: color-mix(in srgb, var(--mqo-type-bg) 50%, #18181b) !important;
                color: var(--mqo-type-text) !important;
                border: 1px solid color-mix(in srgb, var(--mqo-type-border) 70%, #27272a) !important;
            }
            html[data-mqo-dark="true"] .mqo-glyph {
                background: color-mix(in srgb, var(--mqo-type-bg) 52%, #18181b) !important;
                color: var(--mqo-type-icon) !important;
                border-color: color-mix(in srgb, var(--mqo-type-border) 70%, #27272a) !important;
            }
            html[data-mqo-dark="true"] .mqo-toast {
                background: #18181b !important;
                color: #f4f4f5 !important;
                border-color: #3f3f46 !important;
            }
            html[data-mqo-focus="true"] #theme_boost-drawers-courseindex,
            html[data-mqo-focus="true"] #theme_boost-drawers-blocks,
            html[data-mqo-focus="true"] .drawer-left,
            html[data-mqo-focus="true"] .drawer-right,
            html[data-mqo-focus="true"] .drawer-toggler,
            html[data-mqo-focus="true"] [data-region="blocks-column"],
            html[data-mqo-focus="true"] aside.block-region {
                display: none !important;
            }
            html[data-mqo-focus="true"] body,
            html[data-mqo-focus="true"] #page,
            html[data-mqo-focus="true"] #page.drawers,
            html[data-mqo-focus="true"] .main-inner {
                margin-left: 0 !important;
                margin-right: 0 !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
            }
            html[data-mqo-focus="true"] #region-main,
            html[data-mqo-focus="true"] [role="main"] {
                max-width: min(1120px, calc(100vw - 48px)) !important;
                margin-left: auto !important;
                margin-right: auto !important;
            }
            html[data-mqo-compact-course="true"] .course-section-header {
                min-height: 0 !important;
                padding: 10px 14px !important;
            }
            html[data-mqo-compact-course="true"] .section-item {
                margin-bottom: 12px !important;
                padding: 0 !important;
            }
            html[data-mqo-compact-course="true"] .activity-item {
                min-height: 0 !important;
                padding: 8px 10px !important;
                margin: 4px 0 !important;
                border-radius: 8px !important;
            }
            html[data-mqo-compact-course="true"] .activity-grid {
                grid-gap: 8px !important;
                column-gap: 8px !important;
            }
            html[data-mqo-compact-course="true"] .activityiconcontainer,
            html[data-mqo-compact-course="true"] .activityiconcontainer.smaller {
                width: 28px !important;
                height: 28px !important;
                min-width: 28px !important;
            }
            html[data-mqo-compact-course="true"] .activityicon {
                max-width: 18px !important;
                max-height: 18px !important;
            }
            html[data-mqo-compact-course="true"] .activityname,
            html[data-mqo-compact-course="true"] .instancename {
                line-height: 1.3 !important;
            }
            html[data-mqo-compact-course="true"] .section .activity {
                margin-bottom: 2px !important;
            }
        `;
        document.head.appendChild(darkStyleNode);
    }

    function openPalette() {
        if (overlay) {
            closePalette();
            return;
        }

        installBaseStyles();
        mergeCourses(extractCourses(document));
        mergeRecent(extractRecentItems(document));

        const currentCourse = currentCourseFromPage();
        if (currentCourse) mergeModules(currentCourse.id, extractModules(document, currentCourse.id), false);

        paletteState = { selected: 0, filter: "all", query: "", filtered: [] };
        overlay = document.createElement("div");
        overlay.className = "mqo-overlay";
        overlay.innerHTML = `
            <div class="mqo-box ${state.prefs.compactResults ? "mqo-compact" : ""}" role="dialog" aria-label="Moodle command center">
                <div class="mqo-top">
                    <input class="mqo-input" autocomplete="off" spellcheck="false" placeholder="Search Moodle... e.g. linear take home, course: theory, command: dark">
                    <div class="mqo-actions">
                        <button class="mqo-icon-button" data-mqo-action="refresh" title="Refresh full index" aria-label="Refresh full index">${iconSvg("refresh")}</button>
                        <button class="mqo-icon-button" data-mqo-action="clear" title="Clear navigation cache" aria-label="Clear navigation cache">${iconSvg("trash")}</button>
                        <button class="mqo-icon-button" data-mqo-action="close" title="Close" aria-label="Close">${iconSvg("x")}</button>
                    </div>
                </div>
                <div class="mqo-filters"></div>
                <div class="mqo-results"></div>
                <div class="mqo-footer">
                    <span class="mqo-status"></span>
                    <span class="mqo-shortcuts">Enter open · ↑↓ move · Tab filter · Ctrl+R refresh · Esc close</span>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        bindPaletteEvents();
        renderPalette();

        const input = overlay.querySelector(".mqo-input");
        input.focus();

        const shouldFullIndex = Date.now() - state.fullIndexUpdatedAt > CACHE_MS || allModules().length === 0;
        refreshCourses({ full: shouldFullIndex, onProgress: renderPalette }).then(renderPalette).catch(renderPalette);
    }

    function closePalette() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
    }

    function bindPaletteEvents() {
        const input = overlay.querySelector(".mqo-input");

        input.addEventListener("input", () => {
            paletteState.query = input.value;
            paletteState.selected = 0;
            schedulePaletteRender();
        });

        input.addEventListener("keydown", event => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                paletteState.selected = Math.min(paletteState.selected + 1, paletteState.filtered.length - 1);
                renderPalette();
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                paletteState.selected = Math.max(paletteState.selected - 1, 0);
                renderPalette();
            }

            if (event.key === "Tab") {
                event.preventDefault();
                cycleFilter(event.shiftKey ? -1 : 1);
            }

            if (event.key === "Enter" && paletteState.filtered[paletteState.selected]) {
                event.preventDefault();
                paletteState.filtered[paletteState.selected].action();
            }

            if (event.key === "Escape") {
                event.preventDefault();
                closePalette();
            }

            if (event.ctrlKey && event.key.toLowerCase() === "r") {
                event.preventDefault();
                refreshCourses({ full: true, force: true, onProgress: renderPalette }).then(renderPalette).catch(renderPalette);
            }
        });

        overlay.addEventListener("click", event => {
            if (event.target === overlay) closePalette();

            const action = event.target.closest("[data-mqo-action]")?.dataset.mqoAction;
            if (action === "close") closePalette();
            if (action === "refresh") {
                refreshCourses({ full: true, force: true, onProgress: renderPalette }).then(renderPalette).catch(renderPalette);
            }
            if (action === "clear") {
                const prefs = state.prefs;
                state = { ...defaultState(), prefs };
                markDataChanged();
                writeCache();
                refreshCourses({ full: true, force: true, onProgress: renderPalette }).then(renderPalette).catch(renderPalette);
            }

            const filter = event.target.closest("[data-mqo-filter]")?.dataset.mqoFilter;
            if (filter) {
                paletteState.filter = filter;
                paletteState.selected = 0;
                renderPalette();
            }

            const index = event.target.closest("[data-mqo-result]")?.dataset.mqoResult;
            if (index) {
                const command = paletteState.filtered[Number(index)];
                if (command) command.action();
            }
        });
    }

    function cycleFilter(direction) {
        const index = FILTERS.findIndex(filter => filter.id === paletteState.filter);
        const next = (index + direction + FILTERS.length) % FILTERS.length;
        paletteState.filter = FILTERS[next].id;
        paletteState.selected = 0;
        renderPalette();
    }

    function schedulePaletteRender() {
        if (renderTimer) cancelAnimationFrame(renderTimer);
        renderTimer = requestAnimationFrame(() => {
            renderTimer = null;
            renderPalette();
        });
    }

    function renderPalette() {
        if (!overlay) return;

        const box = overlay.querySelector(".mqo-box");
        box.classList.toggle("mqo-compact", state.prefs.compactResults);

        const filters = overlay.querySelector(".mqo-filters");
        filters.innerHTML = FILTERS.map(filter => `
            <button class="mqo-filter ${filter.id === paletteState.filter ? "mqo-filter-active" : ""}" data-mqo-filter="${filter.id}" style="${styleVars(themeForType(filter.id))}">
                ${iconSvg(filter.icon, "mqo-svg mqo-filter-icon")}
                ${filter.label}
            </button>
        `).join("");

        paletteState.filtered = buildCommands(paletteState.query);
        if (paletteState.selected >= paletteState.filtered.length) paletteState.selected = paletteState.filtered.length - 1;
        if (paletteState.selected < 0) paletteState.selected = 0;

        const results = overlay.querySelector(".mqo-results");
        if (paletteState.filtered.length === 0) {
            results.innerHTML = `<div class="mqo-empty">${refreshPromise ? "Indexing Moodle pages..." : "No matching Moodle navigation items found"}</div>`;
        } else {
            results.innerHTML = paletteState.filtered.map((command, index) => `
                <div class="mqo-item ${index === paletteState.selected ? "mqo-item-active" : ""}" data-mqo-result="${index}" style="${styleVars(themeForType(command.type))}">
                    <div class="mqo-glyph">${iconSvg(command.icon || "sparkles")}</div>
                    <div>
                        <div class="mqo-title">${escapeHtml(command.title)}</div>
                        <div class="mqo-subtitle">${escapeHtml(command.subtitle || "")}</div>
                    </div>
                    <div class="mqo-badge">${escapeHtml(command.type)}</div>
                </div>
            `).join("");
        }

        const active = results.querySelector(".mqo-item-active");
        active?.scrollIntoView({ block: "nearest" });

        overlay.querySelector(".mqo-status").textContent = statusText();
    }

    function statusText() {
        if (indexStatus.active) {
            return `${indexStatus.label || "Indexing"} ${indexStatus.indexed}/${indexStatus.total}`;
        }

        const modules = allModules().length;
        const current = currentCourseFromPage();
        const currentCount = current ? currentModules().length : 0;
        const stale = Date.now() - state.fullIndexUpdatedAt > CACHE_MS;
        const featureFlags = [
            state.prefs.focusMode ? "focus mode" : "",
            state.prefs.compactCourse ? "compact course" : ""
        ].filter(Boolean).join(" · ");
        return `${state.courses.length} courses · ${modules} indexed items · ${state.recentItems.length} recent${current ? ` · ${currentCount} current-course items` : ""}${featureFlags ? ` · ${featureFlags}` : ""}${stale ? " · refresh due" : ""}`;
    }

    function escapeHtml(text) {
        return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function shortcutMatches(event, shortcut) {
        const key = event.key.toLowerCase();
        return (
            (shortcut.ctrl ? event.ctrlKey : !event.ctrlKey) &&
            (shortcut.shift ? event.shiftKey : !event.shiftKey) &&
            key === shortcut.key.toLowerCase()
        );
    }

    document.addEventListener("keydown", event => {
        if (shortcutMatches(event, CONFIG.shortcut)) {
            event.preventDefault();
            event.stopPropagation();
            openPalette();
        }

        if (shortcutMatches(event, CONFIG.darkModeShortcut)) {
            event.preventDefault();
            event.stopPropagation();
            setDarkMode(!state.prefs.darkMode);
        }
    }, true);

    setDarkMode(state.prefs.darkMode);
    setFocusMode(state.prefs.focusMode);
    setCompactCourse(state.prefs.compactCourse);
    mergeCourses(extractCourses(document));
    mergeRecent(extractRecentItems(document));

    const currentCourse = currentCourseFromPage();
    if (currentCourse) {
        mergeModules(currentCourse.id, extractModules(document, currentCourse.id), false);
    }

    if (Date.now() - state.updatedAt > CACHE_MS) {
        refreshCourses({ full: Date.now() - state.fullIndexUpdatedAt > CACHE_MS }).catch(() => { });
    }
})();
