# Question bank format

Each note's quiz is stored as a JSON file in `_quiz/banks/`, and each course as a JSON file in `_quiz/courses/`. Recall Lab writes both for you.

You can edit them by hand. If you do, keep each question's `id` the same, because your answer history and review schedule are tied to it.

## A bank

```jsonc
{
  "id": "arch1001-03",
  "title": "Arch1001 · 03 — Registers",
  "note": "Architecture 1001 - Intel x86-64 Assembly/03 Registers.md",
  "questions": [
    {
      "id": "r03-e13",
      "tier": "easy",              // easy | hard | brutal
      "type": "mcq",               // see "Question types" below
      "topic": "abcd-ordering",    // groups weak areas
      "axis": "register-model",    // the course skill area it feeds on the radar
      "prompt": "Which register number is `RBX`?",
      "choices": ["`R3`", "`R1`", "`R2`", "`R4`"],
      "answer": 0,
      "explain": "Shown after answering, whatever the verdict.",
      "ref": "03 Registers#4.1 The ABCD order",
      "timestamp": "P1 03:16",
      "slide": 13
    }
  ]
}
```

| Field | Required | What it is |
|---|---|---|
| `id` | Yes | The bank's id. |
| `title` | Yes | The name shown in Recall Lab. |
| `note` | No | The vault path of the note the bank covers. |
| `questions` | Yes | The questions. |

## Question fields

| Field | Used by | What it is |
|---|---|---|
| `id` | All | Unique within the bank. Your answer history is tied to it. |
| `tier` | All | `easy`, `hard` or `brutal`. |
| `type` | All | One of the [question types](#question-types). |
| `topic` | All | A short slug, such as `width-suffixes`, that groups weak areas. |
| `axis` | All, optional | The id of the course skill area this question feeds. If it's missing, the course's topic map decides. |
| `prompt` | All | The question, in Markdown. |
| `explain` | All | Shown after answering, whatever the verdict. Can be empty. |
| `code` | Optional | Code shown in a monospace block under the prompt. |
| `ref` | Optional | Where the note covers this, as `Note#Heading`. It links to the note and places the question's memory dot. |
| `timestamp`, `slide` | Optional | A lecture timestamp, such as `P1 02:21`, and a slide number. |
| `variants` | Optional | Other versions of the question, with the same fields, written by **Write variants**. |
| `steps` | Optional | Smaller questions, marked on your device, that build up to a brutal problem. Written by **Write guided steps**. |

## Question types

| `type` | Fields | Marked by |
|---|---|---|
| `mcq` | `choices` (at least 2), and `answer`: the index of the right choice. | Your device |
| `multi` | `choices`, and `answer`: an array of the indices of every right choice. | Your device |
| `short` | `expected`: the model answer. `rubric`: the points a full-credit answer must make. `accept`: optional regexes. | Claude, unless an `accept` pattern matches |
| `command` | Same fields as `short`, for a shell command. | Claude, unless an `accept` pattern matches |
| `image` | Same fields as `short`. You attach a screenshot and explain it, and Claude marks the explanation. | Claude |
| `hotspot` | `code`, and `lines`: the 1-based line or lines of `code` that are the answer. | Your device |
| `trace` | `code`, and `trace`: the values after each step (see below). | Your device |
| `order` | `items`: at least three, in the correct order, with no repeats. They are shown shuffled. | Your device |
| `match` | `pairs`: at least three `["left", "right"]` pairs. Every right side must be different. | Your device |
| `cloze` | `cloze`: text with `{{answer}}` or `{{answer\|alternative}}` blanks. | Your device |

**Accept patterns** are case-insensitive regular expressions, such as `["^r3$"]`. A match passes the answer at once, with no Claude request. A pattern that doesn't match never fails the answer; it just sends it to Claude. That way, a correct answer worded in an unusual way can't be failed by a pattern.

**Traces** list what should hold once a line of `code` has run:

```json
"trace": [{ "line": 2, "expect": { "eax": "0x11", "ZF": "0" } }]
```

Answers can be decimal, `0x…`, `…h` or `0b…`. Flags can be `0`/`1` or `set`/`clear`. A negative value is read at the width of the register it names: `-1` is `0xFFFFFFFF` in `eax`, but not in `rax`.

Write 64-bit values as strings. JSON numbers above 2^53 lose precision when the file is read.

**Order the steps** scores you on how much you improved on the shuffle, measured by the longest run in the right order. A list you leave untouched scores nothing.

When Claude builds a quiz, Recall Lab checks every question. It drops a broken hands-on question instead of failing the whole quiz.

## A course

```json
{
  "id": "arch1001",
  "title": "Architecture 1001 — x86-64 Assembly",
  "folder": "Architecture 1001 - Intel x86-64 Assembly",
  "axes": [
    { "id": "register-model", "label": "Registers & Data", "topics": ["abcd-ordering", "width-suffixes"] }
  ]
}
```

- `folder` is the vault folder whose notes belong to the course.
- `axes` are the spokes of the course's radar. A radar needs at least three.
- A question counts toward the axis named in its `axis` field. If it has none, it counts toward an axis whose `topics` include its `topic`.
