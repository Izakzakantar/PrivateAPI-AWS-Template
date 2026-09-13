TODO: Export the architecture diagram to PNG.

`architecture-diagram.drawio` in this folder is the real, editable
architecture diagram (title block, all services, numbered request flow,
and a step legend) covering the request path described in the main
README (Client -> Route 53 -> CloudFront -> CloudFront VPC Origin ->
Internal ALB -> VPC Endpoint -> Private API Gateway -> Lambda ->
DynamoDB). It has not been rendered to a PNG yet -- that step needs
either the draw.io desktop app or a browser, neither of which was
available in the environment that generated this template.

To finish it:

1. Open `architecture-diagram.drawio` at https://app.diagrams.net
   (File > Open From > Device), or install the draw.io desktop app.
2. Export it: File > Export as > PNG (in the browser), or from a
   terminal with draw.io desktop installed:
   `drawio -x -f png -e -b 10 -o docs/architecture-diagram.png docs/architecture-diagram.drawio`
3. Save the result as `docs/architecture-diagram.png`.
4. In the root `README.md`, replace the paragraph pointing at this file
   with `![Architecture Diagram](./docs/architecture-diagram.png)`.

Once the PNG is in place, this note can be deleted.
