Fetch content from a URL. Returns the main text content extracted from the page. Use this when you need to read a specific web page.

When you are looking for something specific on the page (a version, an API signature, a setting, a step), pass `question`: a helper model reads the page and only its answer comes back, which keeps a long page out of your context. Leave `question` out when you need the page text itself (to quote it at length, or to read it whole). A long page without a question comes back as its first part plus the path of a file with the whole text, which you can read with the Read tool.

Only public `http`/`https` URLs are supported. Requests to private, loopback, or link-local addresses are refused, and responses larger than 10 MiB are rejected.
