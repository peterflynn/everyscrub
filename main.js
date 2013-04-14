/*
 * Copyright (c) 2012 Peter Flynn.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50, regexp: true, bitwise: true */
/*global define, brackets, $, window */

define(function (require, exports, module) {
    "use strict";
    
    // Brackets modules
    var EditorManager     = brackets.getModule("editor/EditorManager"),
        InlineTextEditor  = brackets.getModule("editor/InlineTextEditor").InlineTextEditor,
        CommandManager    = brackets.getModule("command/CommandManager"),
        KeyBindingManager = brackets.getModule("command/KeyBindingManager");
    
    
    var isMac = (brackets.platform === "mac");
    
    // Utilities
    function clip(val, max) {
        return (val < 0 ? 0 : (val > max ? max : val));
    }
    
    var uniqueNum = 0;  // used to ensure unique undo batching per drag
    
    
    // Scrubbing a single number (with optional suffix)
    function SimpleNumberScrub(origStringValue, prefix, suffix) {
        this.prefix = prefix;
        this.suffix = suffix;
        this.origValue = parseFloat(origStringValue);
        
        // Increment slower for numbers with decimal (even if it's ".0")
        this.increment = (origStringValue.indexOf(".") === -1) ? 1 : 0.1;
    }
    SimpleNumberScrub.parse = function (token) {
        var candidate;
        if (token.className === "number") {
            // Token type number often occurs in JS and CSS code
            // (although CodeMirror marks all sorts of CSS tokens as "number", including enums like "auto" and segments of URL paths)
            candidate = token.string;
        } else if (token.className === "string") {
            // Token type string may contain a number, e.g. in HTML or SVG code
            candidate = token.string;
        }
        
        // Support numbers with a suffix like "px" or "%"
        var extras = /([^\d\-\.]*)(-?(?:(?:\d*\.)|(?:\d+\.?))\d*)(.*)/.exec(candidate);
        var origStringValue = (extras && extras[2]) || candidate;
        if (isNaN(parseFloat(origStringValue))) {
            return null;
        } else {
            var prefix = (extras && extras[1]) || "";
            var suffix = (extras && extras[3]) || "";
            return new SimpleNumberScrub(origStringValue, prefix, suffix);
        }
    };
    SimpleNumberScrub.prototype.update = function (delta) {
        var newVal = this.origValue + (delta * this.increment);
        if (this.increment < 1) {
            newVal = Math.round(newVal * 10) / 10;  // prevent rounding errors from adding extra decimals
        }
        
        var str = String(newVal);
        if (this.increment < 1 && str.indexOf(".") === -1) {
            str += ".0";    // don't jitter to a shorter length when passing a whole number
        }
        return this.prefix + str + this.suffix;
    };
    
    // Color utils
    function getColorCandidate(token) {
        if (token.className === "atom") {
            // Colors in CSS are type atom
            return token.string;
        } else if (token.className === "number") {
            // Colors in LESS are type number
            return token.string;
        } else if (token.className === "string") {
            // Token type string may contain a number in the attrs of XML-like modes (e.g. HTML or SVG)
            return token.string;
        }
    }
    
    // Scrubbing 3-digit hex color
    function Color3Scrub(string, prefix, suffix) {
        this.prefix = prefix;
        this.suffix = suffix;
        this.r = parseInt(string[1], 16);
        this.g = parseInt(string[2], 16);
        this.b = parseInt(string[3], 16);
    }
    Color3Scrub.parse = function (token) {
        var candidate = getColorCandidate(token);
        var extras = /([^#]*)(#[0-9a-f]{3})([^0-9a-f]+.*|$)/i.exec(candidate);
        if (extras) {
            var colorStr = (extras && extras[2]) || "";
            var prefix = (extras && extras[1]) || "";
            var suffix = (extras && extras[3]) || "";
            return new Color3Scrub(colorStr, prefix, suffix);
        }
    };
    Color3Scrub.prototype.update = function (delta) {
        var r = clip(this.r + delta, 15);
        var g = clip(this.g + delta, 15);
        var b = clip(this.b + delta, 15);
        return this.prefix + "#" + r.toString(16) + g.toString(16) + b.toString(16) + this.suffix;
    };
    
    // Scrubbing 6-digit hex color
    function Color6Scrub(string, prefix, suffix) {
        this.prefix = prefix;
        this.suffix = suffix;
        this.r = parseInt(string[1] + string[2], 16);
        this.g = parseInt(string[3] + string[4], 16);
        this.b = parseInt(string[5] + string[6], 16);
    }
    Color6Scrub.parse = function (token) {
        var candidate = getColorCandidate(token);
        var extras = /([^#]*)(#[0-9a-f]{6})([^0-9a-f]+.*|$)/i.exec(candidate);
        if (extras) {
            var colorStr = (extras && extras[2]) || "";
            var prefix = (extras && extras[1]) || "";
            var suffix = (extras && extras[3]) || "";
            return new Color6Scrub(colorStr, prefix, suffix);
        }
    };
    Color6Scrub.prototype.update = function (delta) {
        function force2Digits(str) {
            if (str.length === 1) {
                str = "0" + str;
            }
            return str;
        }
        var r = clip(this.r + delta, 255);
        var g = clip(this.g + delta, 255);
        var b = clip(this.b + delta, 255);
        return this.prefix + "#" + force2Digits(r.toString(16)) + force2Digits(g.toString(16)) + force2Digits(b.toString(16)) + this.suffix;
    };
    
    function parseForScrub(token) {
        var initialState = (
            Color3Scrub.parse(token) ||
            Color6Scrub.parse(token) ||
            SimpleNumberScrub.parse(token)
        );
        if (initialState) {
            // in Sprint 20 (CMv3), this ensures the entire drag (or consecutive nudges) is undone atomically; ignored in earlier builds
            initialState.origin = "*everyscrub" + (++uniqueNum);
        }
        return initialState;
    }
    
    function correctTokenAtLineForCodeMirrorIdiosyncrasiesUsingEditor(token, line, editor) {
        var decimalSeparatorToken;
        if (token.className === "number") {
            if (token.string.indexOf(".") === -1) {
                // if it doesn't contain a decimal separator point already check whether there is one in front of it
                // because that wouldn't be included in the number token itself
                decimalSeparatorToken = editor._codeMirror.getTokenAt({line: line, ch: token.start}); // start is the end of the previous token and CodeMirror looks for the token ending there
                if ((decimalSeparatorToken.className === null) && (decimalSeparatorToken.string === ".")) {
                    // there is indeed a decimal separator token in front of the number, include it when parsing for the scrub
                    token = {
                        className: token.className,
                        string: decimalSeparatorToken.string + token.string,
                        start: decimalSeparatorToken.start,
                        end: token.end,
                        state: token.state
                    };
                }
            }
        } else if ((token.className === null) && (token.string === ".")) {
            // we got a "." which might be the start of a float like .23
            // check the next token
            decimalSeparatorToken = token;
            token = editor._codeMirror.getTokenAt({line: line, ch: decimalSeparatorToken.end + 1});
            if (token.className === "number") {
                token = {
                    className: token.className,
                    string: decimalSeparatorToken.string + token.string,
                    start: decimalSeparatorToken.start,
                    end: token.end,
                    state: token.state
                };
            } else {
                token = decimalSeparatorToken;
            }
        }
        return token;
    }

    
    /** Main scrubbing event handling. Detects number format, adds global move/up listeners, detaches when done */
    function handleEditorMouseDown(editor, event) {
        // Drag state
        var scrubState; // instance of one of the *Scrub classes
        var downX;      // mousedown pageX
        var lastValue;  // last value from scrubState.update()
        var lastRange;  // text range of lastValue in the code
        
        function delta(event) {
            var pxDelta = event.pageX - downX;
            return (pxDelta / 8) | 0;   // "| 0" truncates to int
        }
        
        function moveHandler(event) {
            var newVal = scrubState.update(delta(event));
            
            if (newVal !== lastValue) {
                lastValue = newVal;
                editor._codeMirror.replaceRange(newVal, lastRange.start, lastRange.end, scrubState.origin);
                lastRange.end.ch = lastRange.start.ch + newVal.length;
                editor.setSelection(lastRange.start, lastRange.end);
            }
        }
        function upHandler(event) {
            $(window.document).off("mousemove", moveHandler);
            $(window.document).off("mouseup", upHandler);
        }
        
        //  coordsChar() returns the closest insertion point, not always char the click was ON.
        //  -------------------
        //  |     I* X  |     |     * = mousedn
        //  -------------------     X = coordsChar().ch, interpreted as a char pos
        //  |     |    *I  X  |     I = coordsChar().ch, interpreted as a cursor pos / insertion point
        //  -------------------
        var pos = editor._codeMirror.coordsChar({x: event.pageX, y: event.pageY, left: event.pageX, top: event.pageY});  // x/y for CMv2; left/top for v3
        var charBounds = editor._codeMirror.charCoords(pos);
        var chLeftEdge = (charBounds.x !== undefined) ? charBounds.x : charBounds.left;  // x for CMv2; left for CMv3
        var mousedownCh = (chLeftEdge <= event.pageX) ? pos.ch : pos.ch - 1;
        
        // ch+1 because getTokenAt() returns the token *ending* at cursor pos 'ch' (char at 'ch' is NOT part of the token)
        var token = editor._codeMirror.getTokenAt({line: pos.line, ch: mousedownCh + 1});
        token = correctTokenAtLineForCodeMirrorIdiosyncrasiesUsingEditor(token, pos.line, editor);
        
        // Is this token a value we can scrub? Init value-specific state if so
        scrubState = parseForScrub(token);
        
        if (scrubState) {
            event.stopPropagation();
            event.preventDefault();
            
            downX = event.pageX;
            
            lastValue = token.string;
            lastRange = {start: {line: pos.line, ch: token.start}, end: {line: pos.line, ch: token.end}};
            $(window.document).mousemove(moveHandler);
            $(window.document).mouseup(upHandler);
            
            editor.setSelection(lastRange.start, lastRange.end);
        }
    }
    
    
    /** Finds innermost editor containing the given element */
    function editorFromElement(element) {
        var result;
        var fullEditor = EditorManager.getCurrentFullEditor();
        if (fullEditor) {
            fullEditor.getInlineWidgets().forEach(function (widget) {
                if (widget.htmlContent.contains(element)) {
                    if (widget instanceof InlineTextEditor) {
                        widget.editors.forEach(function (editor) {
                            if (editor.getRootElement().contains(element)) {
                                result = editor;
                            }
                        });
                    } else {
                        // Ignore mousedown on inline widgets other than editors
                        result = null;
                    }
                }
            });
            
            if (result !== undefined) {
                return result;
            } else {
                return fullEditor;
            }
        }
        return null;
    }
    
    function handleMouseDown(event) {
        // We only care about ctrl+drag on Win, cmd+drag on Mac
        if (event.which === 1 && ((isMac && event.metaKey) || (!isMac && event.ctrlKey))) {
            // Which editor did mousedown occur on (inline vs. full-size vs. no editor open)
            var editor = editorFromElement(event.target);
            if (editor) {
                handleEditorMouseDown(editor, event);
            }
        }
    }
    
    
    // Remember state between consecutive nudges of the same number. Otherwise nudging colors wouldn't work well
    // because we lose the original once one channel saturates
    var lastNudge = null;
    
    function nudge(dir) {
        var editor = EditorManager.getFocusedEditor();
        if (!editor) {
            return;
        }
        var cursorPos = editor.getCursorPos();
        
        function getScrubState(token) {
            // We're continuing the last nudge if it's in the same place and the text is how we left it
            if (lastNudge && cursorPos.line === lastNudge.line && token.start === lastNudge.ch && token.string === lastNudge.lastText) {
                lastNudge.delta += dir;
                return lastNudge.scrubState;
            } else {
                var newState = parseForScrub(token);
                if (newState) {
                    // Found a token to nudge that's not the last one we used, so re-init lastNudge. Don't touch lastNudge
                    // if newState is null, since we might retry to the R of the cursor and find a match to lastNudge.
                    lastNudge = { scrubState: newState, delta: dir, line: cursorPos.line, ch: token.start };
                }
                return newState;
            }
        }
        
        // First try the token to the L of the cursor
        var token = editor._codeMirror.getTokenAt(cursorPos);
        token = correctTokenAtLineForCodeMirrorIdiosyncrasiesUsingEditor(token, cursorPos.line, editor);
        var scrubState = getScrubState(token);
        if (!scrubState) {
            // If not, try to the R of the cursor
            cursorPos.ch++;
            token = editor._codeMirror.getTokenAt(cursorPos);
            token = correctTokenAtLineForCodeMirrorIdiosyncrasiesUsingEditor(token, cursorPos.line, editor);
            scrubState = getScrubState(token);
        }
        
        if (scrubState) {
            var newVal = scrubState.update(lastNudge.delta);
            var tokenRange = {start: {line: cursorPos.line, ch: token.start}, end: {line: cursorPos.line, ch: token.end}};
            editor._codeMirror.replaceRange(newVal, tokenRange.start, tokenRange.end, scrubState.origin);
            lastNudge.lastText = newVal;
            
            tokenRange.end.ch = tokenRange.start.ch + newVal.length;
            editor.setSelection(tokenRange.start, tokenRange.end);
        }

    }
    
    // Init: listen to all mousedowns in the editor area
    $("#editor-holder")[0].addEventListener("mousedown", handleMouseDown, true);
    
    // Keyboard shortcuts to "nudge" value up/down
    var CMD_NUDGE_UP = "pflynn.everyscrub.nudge_up",
        CMD_NUDGE_DN = "pflynn.everyscrub.nudge_down";
    CommandManager.register("Increment Number", CMD_NUDGE_UP, function () { nudge(+1); });
    CommandManager.register("Decrement Number", CMD_NUDGE_DN, function () { nudge(-1); });
    KeyBindingManager.addBinding(CMD_NUDGE_UP, "Shift-Alt-Up");
    KeyBindingManager.addBinding(CMD_NUDGE_DN, "Shift-Alt-Down");
});