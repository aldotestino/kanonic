I've been working on this library called kanonic. It's intende to be a wrapper around fetch. but I'm now questioning some of its internals.
what I like:

- result type with better-result -> the code never throws it always returns a Result type with success and error data.
- schema driven: the possibility of creating a client organzing api methods with the createEndpoints utility and the createApi and ApiService utilities.
- the plugin system, being able to have plugins that can modify the request and the response before continue processing (this allows for high composability, having a validator layer, logger layer, telemetry layer and so on...)
- retryiabilty

hat I don't like:

- can't just use the basic functionality: having a safe wrapper around the base fetch. I want to just be able to call kanonic<T>(url, {method, headers...}) where T is the response type
- createApi/ApiService/createEndpoints shuould just be utilities to quickly define stuff (the api that is there I like)
- only send and receive json, the body should be transformed depending on the content-type header passed (obviously the default should be json)
- no timeout

basically everything should be around a single function called kanonic that wraps the base fetch.
it should accept plugins, retry, timeout, output schema and error schema
