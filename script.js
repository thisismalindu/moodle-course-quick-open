// ==UserScript==
// @name         Moodle Course Quick Open
// @namespace    moodle-quick-open
// @version      1.2
// @description  Ctrl+Shift+K quick course search for Moodle-based websites
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
        shortcut: { ctrl: true, shift: true, key: "k" } // Change this to your desired shortcut
    };

    // DO NOT TOUCH BELOW THIS LINE UNLESS YOU KNOW WHAT YOU ARE DOING

    // Stop script from running on other sites
    if (window.location.hostname !== CONFIG.targetSite) return;

    let overlay = null;

    function collectCourses() {
        return [...document.querySelectorAll(".block_course_list a[href*='/course/view.php']")]
            .map(a => ({
                title: a.textContent.trim(),
                url: a.href
            }))
            .filter(c => c.title.length > 0);
    }

    function openQuickSearch() {
        if (overlay) {
            overlay.remove();
            overlay = null;
            return;
        }

        const courses = collectCourses();
        let selected = 0;
        let filtered = courses;

        overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.35);
            z-index: 999999;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding-top: 90px;
            font-family: Arial, sans-serif;
        `;

        const box = document.createElement("div");
        box.style.cssText = `
            width: min(720px, 92vw);
            background: white;
            border-radius: 10px;
            box-shadow: 0 12px 45px rgba(0,0,0,0.35);
            overflow: hidden;
        `;

        const input = document.createElement("input");
        input.placeholder = "Search courses... e.g. linear, ai, network, database";
        input.style.cssText = `
            width: 100%;
            box-sizing: border-box;
            padding: 16px;
            font-size: 18px;
            border: none;
            outline: none;
            border-bottom: 1px solid #ddd;
        `;

        const results = document.createElement("div");
        results.style.cssText = `
            max-height: 430px;
            overflow-y: auto;
        `;

        function matches(course, query) {
            query = query.toLowerCase().trim();
            return course.title.toLowerCase().includes(query);
        }

        function render() {
            const query = input.value;
            filtered = courses.filter(c => matches(c, query)).slice(0, 15);

            if (selected >= filtered.length) selected = filtered.length - 1;
            if (selected < 0) selected = 0;

            results.innerHTML = "";

            if (filtered.length === 0) {
                results.innerHTML = `
                    <div style="padding: 16px; color: #777;">
                        No matching courses found
                    </div>
                `;
                return;
            }

            filtered.forEach((course, index) => {
                const item = document.createElement("div");
                item.textContent = course.title;

                item.style.cssText = `
                    padding: 13px 16px;
                    cursor: pointer;
                    font-size: 15px;
                    background: ${index === selected ? "#eef3ff" : "white"};
                    border-bottom: 1px solid #f1f1f1;
                `;

                item.addEventListener("mouseenter", () => {
                    selected = index;
                    render();
                });

                item.addEventListener("click", () => {
                    window.location.href = course.url;
                });

                results.appendChild(item);
            });
        }

        input.addEventListener("input", () => {
            selected = 0;
            render();
        });

        input.addEventListener("keydown", e => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                selected = Math.min(selected + 1, filtered.length - 1);
                render();
            }

            if (e.key === "ArrowUp") {
                e.preventDefault();
                selected = Math.max(selected - 1, 0);
                render();
            }

            if (e.key === "Enter" && filtered[selected]) {
                window.location.href = filtered[selected].url;
            }

            if (e.key === "Escape") {
                overlay.remove();
                overlay = null;
            }
        });

        overlay.addEventListener("click", e => {
            if (e.target === overlay) {
                overlay.remove();
                overlay = null;
            }
        });

        box.appendChild(input);
        box.appendChild(results);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        input.focus();
        render();
    }

    document.addEventListener("keydown", e => {
        const key = e.key.toLowerCase();

        const shortcut =
            (CONFIG.shortcut.ctrl ? e.ctrlKey : !e.ctrlKey) &&
            (CONFIG.shortcut.shift ? e.shiftKey : !e.shiftKey) &&
            key === CONFIG.shortcut.key.toLowerCase();

        if (shortcut) {
            e.preventDefault();
            e.stopPropagation();
            openQuickSearch();
        }
    }, true);
})();