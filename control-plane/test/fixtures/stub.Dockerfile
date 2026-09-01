# Throwaway ~2MB stub standing in for the real 2.89GB arigami image in the
# K8S-2 integration proof — same reasoning as deploy/helm/arigami-tenant/ci
# /stub-values.yaml (K8S-1): the control-plane's provisioner only needs
# something that starts, serves /__health, and writes to /data — not the
# real app. Never pushed anywhere, built and k3d-imported locally, removed
# by name at teardown.
FROM busybox:1.36
RUN mkdir -p /www && \
    echo '{"ok":true}' > /www/__health && \
    echo '<html><body>arigami-cp-stub ok</body></html>' > /www/index.html
