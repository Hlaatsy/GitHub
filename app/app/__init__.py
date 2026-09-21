"""IDENTICAL — the app.

What is bought and what is built:

    bought   photo -> talking video, voice cloning, translation  (provider.py)
    built    accounts, plans, quotas, credits, consent, delivery (everything else)

The provider is behind one interface so the vendor decision stays a single
class. Everything around it -- the part that makes this IDENTICAL rather than
a login to someone else's platform -- lives here.
"""
