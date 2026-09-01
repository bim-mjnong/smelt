package fixture.example;

import java.util.List;

/** A parser nobody asked about — javadoc attached, collapsible with it. */
class ConfigParser {
  static List<String> parse(String raw) {
    return List.of(raw.split(","));
  }
}

/** The class this file is really about. */
public class RequestHandler {
  String handle(String path) {
    return "handled:" + path;
  }
}

/** Renders one response body. A collapsible sibling below the target. */
class ResponseRenderer {
  String render(String path) {
    return "{" + path + "}";
  }
}

/** Writes one line to stdout. The most boring sibling of all. */
class LineLogger {
  void log(String line) {
    System.out.println(line);
  }
}
