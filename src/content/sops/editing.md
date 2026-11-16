## Editing

The studio works one of two ways, set in `src/lib/business.ts` (`editing`).

### Edited outside the studio ("manual")

- Edit the shoot in your own editing app as usual.
- Open the listing (Listings, the listing, **Upload photos**) and drop the finished photos in. They go straight onto the listing; nothing is sent to editing.
- They land as Internal only. Check them, then make them Client visible or Publish.
- Raw video still goes through Upload a shoot, which copies it to Dropbox.

### Edited by the editing service ("autohdr")

- Raw uploads start editing the moment the shooter submits. Finished frames come back into the shoot as QC pending, unpublished.
- Corrections are made outside the studio and uploaded as finals by the same file name: they replace the frame, approved but unpublished until Publish.

Either way, twilight and other add-ons have their own section in the gallery, and the client never hears the name of an editing tool or vendor.
